// 业务规则层（纯函数、常量、类型）：阀颈扭矩复核 + 充填后泄漏放行
// 本文件不保存任何状态，所有判定均可直接单元测试。

// ───────────────────────── 规则常量 ─────────────────────────

/** 阀颈允许扭矩区间：35~45 N·m（含边界） */
export const TORQUE_MIN_NM = 35;
export const TORQUE_MAX_NM = 45;

/** 充填后静置时长：5 分钟 */
export const REST_MILLIS = 5 * 60 * 1000;

/** 泄漏压降上限：3 bar（>3 bar 不得签收） */
export const LEAK_LIMIT_BAR = 3;

/** 检验到期预警窗口：剩余 30 天 */
export const INSPECT_WARN_DAYS = 30;

// ───────────────────────── 基础类型 ─────────────────────────

export type GasKind = "空气" | "高氧" | "Trimix";

export type FillMethod = "空压机" | "增压机" | "分压混配";

/** 待充填入队登记 */
export interface OrderDraft {
  tankNo: string;
  volumeL: number | null;
  inspectUntil: string; // yyyy-mm-dd
  residualBar: number | null;
  targetBar: number | null;
  o2Pct: number | null;
  hePct: number | null;
  method: FillMethod;
  operator: string;
}

/** 阀颈装配复核登记 */
export interface AssemblyDraft {
  valveNo: string;
  oRingBatch: string; // O 型圈批次号
  torqueNm: number | null;
  assembler: string; // 装配人
}

export type InspectState = "ok" | "warn" | "expired";

/** O 型圈批次台账：过期批次不得用于放行 */
export interface ORingBatch {
  code: string;
  vendor: string;
  expiresOn: string; // yyyy-mm-dd
}

// ───────────────────────── 混合气规则 ─────────────────────────

export function gasKindOf(o2Pct: number, hePct: number): GasKind {
  if (hePct > 0) return "Trimix";
  if (o2Pct > 22) return "高氧";
  return "空气";
}

/** 氮含量（剩余比例），用于混合气比例提示 */
export function nitrogenPct(o2Pct: number, hePct: number): number {
  return Math.max(0, 100 - o2Pct - hePct);
}

/** 混合气登记字段校验，返回字段级错误 */
export function validateOrder(draft: OrderDraft): Partial<Record<keyof OrderDraft, string>> {
  const errors: Partial<Record<keyof OrderDraft, string>> = {};
  if (!draft.tankNo.trim()) errors.tankNo = "必填气瓶编号";
  if (draft.volumeL === null || draft.volumeL <= 0) errors.volumeL = "容积须大于 0";
  if (!draft.inspectUntil) errors.inspectUntil = "选择检验有效期";
  if (draft.residualBar === null || draft.residualBar < 0) errors.residualBar = "残压不能为负";
  if (draft.targetBar === null || draft.targetBar <= 0) errors.targetBar = "目标压力须大于 0";
  if (
    draft.residualBar !== null &&
    draft.targetBar !== null &&
    draft.targetBar <= draft.residualBar
  ) {
    errors.targetBar = "目标压力须高于残压";
  }
  if (draft.o2Pct === null || draft.o2Pct < 0 || draft.o2Pct > 100) {
    errors.o2Pct = "氧含量取 0~100";
  }
  if (draft.hePct === null || draft.hePct < 0 || draft.hePct > 100) {
    errors.hePct = "氦含量取 0~100";
  }
  if (
    draft.o2Pct !== null &&
    draft.hePct !== null &&
    draft.o2Pct + draft.hePct > 100
  ) {
    errors.hePct = "氧+氦合计不能超过 100%";
  }
  if (!draft.operator.trim()) errors.operator = "必填操作员";
  return errors;
}

// ───────────────────────── 检验有效期 ─────────────────────────

/** 检验有效期判定：过期 / 30 天内预警 / 正常 */
export function inspectStateOf(inspectUntil: string, now: number): InspectState {
  if (!inspectUntil) return "expired";
  const end = new Date(inspectUntil + "T23:59:59").getTime();
  if (Number.isNaN(end)) return "expired";
  const days = (end - now) / (24 * 60 * 60 * 1000);
  if (days < 0) return "expired";
  if (days <= INSPECT_WARN_DAYS) return "warn";
  return "ok";
}

// ───────────────────────── O 型圈批次 ─────────────────────────

/** 批次台账（演示数据，相对今天动态计算，避免长期失真） */
export function oRingBatches(now: number): ORingBatch[] {
  const day = 24 * 60 * 60 * 1000;
  const fmt = (t: number) => new Date(t).toISOString().slice(0, 10);
  return [
    { code: "OR-2608-A", vendor: "旭阳密封", expiresOn: fmt(now + 120 * day) },
    { code: "OR-2603-C", vendor: "海辰橡胶", expiresOn: fmt(now + 18 * day) },
    { code: "OR-2511-B", vendor: "海辰橡胶", expiresOn: fmt(now - 20 * day) },
  ];
}

export function findBatch(code: string, now: number): ORingBatch | undefined {
  return oRingBatches(now).find((b) => b.code === code);
}

/** 批次是否可用：台账存在且未过期 */
export function batchUsable(code: string, now: number): boolean {
  const batch = findBatch(code, now);
  if (!batch) return false;
  return new Date(batch.expiresOn + "T23:59:59").getTime() >= now;
}

// ───────────────────────── 扭矩与放行判定 ─────────────────────────

/** 装配登记字段校验 */
export function validateAssembly(
  draft: AssemblyDraft
): Partial<Record<keyof AssemblyDraft, string>> {
  const errors: Partial<Record<keyof AssemblyDraft, string>> = {};
  if (!draft.valveNo.trim()) errors.valveNo = "必填阀体号";
  if (!draft.oRingBatch.trim()) errors.oRingBatch = "选择 O 型圈批次";
  if (draft.torqueNm === null || Number.isNaN(draft.torqueNm)) {
    errors.torqueNm = "必填扭矩";
  }
  if (!draft.assembler.trim()) errors.assembler = "必填装配人";
  return errors;
}

export interface AssemblyVerdict {
  /** 扭矩落在 35~45 N·m 且 O 圈批次在册未过期 */
  pass: boolean;
  torqueOk: boolean;
  batchOk: boolean;
  reasons: string[];
}

/**
 * 装配复核结论：
 * 扭矩越界或 O 圈批次缺失/过期 → 不通过，气瓶只能进入「待检」。
 */
export function assemblyVerdict(d: AssemblyDraft, now: number): AssemblyVerdict {
  const torque = d.torqueNm;
  const torqueOk = torque !== null && torque >= TORQUE_MIN_NM && torque <= TORQUE_MAX_NM;
  const batchOk = batchUsable(d.oRingBatch.trim(), now);
  const reasons: string[] = [];
  if (!torqueOk)
    reasons.push(`扭矩 ${torque ?? "—"} N·m 不在 ${TORQUE_MIN_NM}~${TORQUE_MAX_NM} N·m`);
  if (!batchOk) {
    const batch = findBatch(d.oRingBatch.trim(), now);
    reasons.push(
      batch
        ? `O 型圈批次 ${batch.code} 已于 ${batch.expiresOn} 过期`
        : `O 型圈批次 ${d.oRingBatch || "（空）"} 不在台账`
    );
  }
  return { pass: torqueOk && batchOk, torqueOk, batchOk, reasons };
}

/** 距静置满 5 分钟的剩余毫秒（<=0 表示可检漏） */
export function restRemaining(filledAt: number | null, now: number): number {
  if (filledAt === null) return REST_MILLIS;
  return Math.max(0, filledAt + REST_MILLIS - now);
}

export function formatRemain(ms: number): string {
  const total = Math.ceil(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** 检漏压降：充填压力 - 当前实测压力 */
export function pressureDrop(targetBar: number, currentBar: number): number {
  return targetBar - currentBar;
}

export interface ReleaseCheck {
  canSign: boolean;
  reasons: string[];
}

/**
 * 放行签收硬规则：
 * 1. 静置未满 5 分钟 → 等待；
 * 2. 泄漏压降 > 3 bar → 拒收；
 * 3. 复核人 == 装配人 → 职责分离，禁止签收；
 * 4. 当前装配扭矩越界 / 批次过期（更正后重判）→ 先处置。
 */
export function evaluateRelease(input: {
  filledAt: number | null;
  now: number;
  torqueNm: number;
  oRingBatch: string;
  currentBar: number | null;
  targetBar: number;
  reviewer: string;
  assembler: string;
}): ReleaseCheck {
  const reasons: string[] = [];
  const remain = restRemaining(input.filledAt, input.now);
  if (remain > 0) reasons.push(`静置未满 5 分钟，还需 ${formatRemain(remain)}`);

  const verdict = assemblyVerdict(
    { valveNo: "__release__", oRingBatch: input.oRingBatch, torqueNm: input.torqueNm, assembler: input.assembler },
    input.now
  );
  if (!verdict.torqueOk)
    reasons.push(`当前扭矩 ${input.torqueNm} N·m 不在 ${TORQUE_MIN_NM}~${TORQUE_MAX_NM} N·m`);
  if (!verdict.batchOk) reasons.push(verdict.reasons.find((r) => r.includes("O 型圈")) ?? "O 型圈批次不可用");

  if (input.currentBar === null || Number.isNaN(input.currentBar)) {
    reasons.push("填写静置后实测压力");
  } else {
    const drop = pressureDrop(input.targetBar, input.currentBar);
    if (drop > LEAK_LIMIT_BAR) reasons.push(`泄漏压降 ${drop.toFixed(1)} bar 超过 ${LEAK_LIMIT_BAR} bar，禁止签收`);
  }

  if (!input.reviewer.trim()) {
    reasons.push("填写复核人");
  } else if (input.reviewer.trim() === input.assembler.trim()) {
    reasons.push("复核人与装配人相同，不得签收（须换人复核）");
  }

  return { canSign: reasons.length === 0, reasons };
}

// ───────────────────────── 展示辅助 ─────────────────────────

export function formatDateTime(t: number): string {
  if (!t) return "—";
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function formatDate(iso: string): string {
  if (!iso) return "—";
  return iso;
}
