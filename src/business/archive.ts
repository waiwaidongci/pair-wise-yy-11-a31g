// 存档层：localStorage 持久化 + 单瓶唯一未结装配复核单 + 修订/失效/履历事件流。
// 所有写操作都走本模块，保证队列、单瓶履历在刷新 / 多标签页后一致。

import {
  AssemblyDraft,
  FillMethod,
  GasKind,
  OrderDraft,
  assemblyVerdict,
  evaluateRelease,
  gasKindOf,
} from "./rules";

const STORAGE_KEY = "fill-station-archive-v1";

// ───────────────────────── 数据模型 ─────────────────────────

export interface AssemblyRecord {
  valveNo: string;
  oRingBatch: string;
  torqueNm: number;
  assembler: string;
  at: number;
}

export interface AssemblyAttempt extends AssemblyRecord {
  kind: "register" | "revise";
  seq: number;
  passed: boolean;
  reasons: string[];
}

export interface ReleaseRecord {
  reviewer: string;
  currentBar: number;
  dropBar: number;
  signedAt: number;
  /** 签收瞬间冻结的装配数据；后续换阀/更正扭矩不修改此快照 */
  snapshot: AssemblyRecord;
}

export type OrderStage =
  | "queued" // 已入队，待装配复核
  | "await-check" // 复核未过（扭矩越界/批次过期），只进待检
  | "ready" // 复核通过，待充填
  | "filling" // 已充填，5 分钟静置中
  | "released"; // 已放行签收

export interface TankOrder {
  id: string;
  tankNo: string;
  volumeL: number;
  inspectUntil: string;
  residualBar: number;
  targetBar: number;
  o2Pct: number;
  hePct: number;
  gasKind: GasKind;
  method: FillMethod;
  operator: string;
  createdAt: number;

  stage: OrderStage;

  /** 未结束装配复核单号；每瓶至多一张，重复/并发打开沿用首次 */
  reviewSheetId: string | null;
  sheetOpenedAt: number | null;
  /** 当前生效的装配状态（最近一次登记/更正） */
  assembly: AssemblyRecord | null;
  /** 最近一次复核结论 */
  assemblyPassed: boolean;
  /** 全部登记与更正留痕 */
  attempts: AssemblyAttempt[];

  filledAt: number | null;

  release: ReleaseRecord | null;
  releaseVoided: boolean;
  voidReason: string | null;
}

export interface TimelineEvent {
  id: string;
  tankNo: string;
  orderId: string;
  time: number;
  kind:
    | "入队"
    | "开单"
    | "复核通过"
    | "转待检"
    | "充填"
    | "放行"
    | "放行失效"
    | "更正装配";
  detail: string;
}

export interface ArchiveState {
  orders: Record<string, TankOrder>;
  events: Record<string, TimelineEvent[]>; // 按气瓶编号归档，跨单据长期保留
}

// ───────────────────────── 工具 ─────────────────────────

function uid(prefix: string): string {
  const rnd =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return `${prefix}-${Date.now().toString(36)}-${rnd}`;
}

// ───────────────────────── 初始演示数据 ─────────────────────────

function seedState(now: number): ArchiveState {
  const day = 24 * 60 * 60 * 1000;
  const date = (offsetDays: number) => new Date(now + offsetDays * day).toISOString().slice(0, 10);
  const state: ArchiveState = { orders: {}, events: {} };

  const pushEvent = (e: Omit<TimelineEvent, "id">) => {
    const ev: TimelineEvent = { ...e, id: uid("evt") };
    (state.events[ev.tankNo] ??= []).push(ev);
  };

  // TANK-204：刚入队，尚未开复核单
  const q1 = uid("ord");
  state.orders[q1] = {
    id: q1,
    tankNo: "TANK-204",
    volumeL: 12,
    inspectUntil: date(200),
    residualBar: 55,
    targetBar: 200,
    o2Pct: 21,
    hePct: 0,
    gasKind: "空气",
    method: "空压机",
    operator: "阿滨",
    createdAt: now - 6 * 60 * 1000,
    stage: "queued",
    reviewSheetId: null,
    sheetOpenedAt: null,
    assembly: null,
    assemblyPassed: false,
    attempts: [],
    filledAt: null,
    release: null,
    releaseVoided: false,
    voidReason: null,
  };
  pushEvent({ tankNo: "TANK-204", orderId: q1, time: now - 6 * 60 * 1000, kind: "入队", detail: "12L 铝瓶 · 空气 · 残压 55 → 200 bar" });

  // TANK-240：扭矩 48 越界，待检
  const q2 = uid("ord");
  const sheet2 = uid("sheet");
  state.orders[q2] = {
    id: q2,
    tankNo: "TANK-240",
    volumeL: 11,
    inspectUntil: date(90),
    residualBar: 40,
    targetBar: 230,
    o2Pct: 32,
    hePct: 0,
    gasKind: "高氧",
    method: "分压混配",
    operator: "阿滨",
    createdAt: now - 15 * 60 * 1000,
    stage: "await-check",
    reviewSheetId: sheet2,
    sheetOpenedAt: now - 14 * 60 * 1000,
    assembly: { valveNo: "V-7781", oRingBatch: "OR-2608-A", torqueNm: 48, assembler: "老郭", at: now - 12 * 60 * 1000 },
    assemblyPassed: false,
    attempts: [
      {
        valveNo: "V-7781",
        oRingBatch: "OR-2608-A",
        torqueNm: 48,
        assembler: "老郭",
        at: now - 12 * 60 * 1000,
        kind: "register",
        seq: 1,
        passed: false,
        reasons: ["扭矩 48 N·m 不在 35~45 N·m"],
      },
    ],
    filledAt: null,
    release: null,
    releaseVoided: false,
    voidReason: null,
  };
  pushEvent({ tankNo: "TANK-240", orderId: q2, time: now - 15 * 60 * 1000, kind: "入队", detail: "11L 钢瓶 · EAN32 · 目标 230 bar" });
  pushEvent({ tankNo: "TANK-240", orderId: q2, time: now - 14 * 60 * 1000, kind: "开单", detail: `装配复核单 ${sheet2}` });
  pushEvent({ tankNo: "TANK-240", orderId: q2, time: now - 12 * 60 * 1000, kind: "转待检", detail: "扭矩 48 N·m 超出 35~45 N·m，只进待检" });

  // TANK-219：复核通过，已充填静置 2 分钟
  const q3 = uid("ord");
  const sheet3 = uid("sheet");
  state.orders[q3] = {
    id: q3,
    tankNo: "TANK-219",
    volumeL: 12,
    inspectUntil: date(400),
    residualBar: 30,
    targetBar: 220,
    o2Pct: 18,
    hePct: 35,
    gasKind: "Trimix",
    method: "分压混配",
    operator: "小周",
    createdAt: now - 20 * 60 * 1000,
    stage: "filling",
    reviewSheetId: sheet3,
    sheetOpenedAt: now - 19 * 60 * 1000,
    assembly: { valveNo: "V-7742", oRingBatch: "OR-2608-A", torqueNm: 40, assembler: "老郭", at: now - 17 * 60 * 1000 },
    assemblyPassed: true,
    attempts: [
      {
        valveNo: "V-7742",
        oRingBatch: "OR-2608-A",
        torqueNm: 40,
        assembler: "老郭",
        at: now - 17 * 60 * 1000,
        kind: "register",
        seq: 1,
        passed: true,
        reasons: [],
      },
    ],
    filledAt: now - 2 * 60 * 1000,
    release: null,
    releaseVoided: false,
    voidReason: null,
  };
  pushEvent({ tankNo: "TANK-219", orderId: q3, time: now - 20 * 60 * 1000, kind: "入队", detail: "12L 双瓶 · Trimix 18/35 · 目标 220 bar" });
  pushEvent({ tankNo: "TANK-219", orderId: q3, time: now - 19 * 60 * 1000, kind: "开单", detail: `装配复核单 ${sheet3}` });
  pushEvent({ tankNo: "TANK-219", orderId: q3, time: now - 17 * 60 * 1000, kind: "复核通过", detail: "阀体 V-7742 · 扭矩 40 N·m · O 圈 OR-2608-A · 装配人 老郭" });
  pushEvent({ tankNo: "TANK-219", orderId: q3, time: now - 2 * 60 * 1000, kind: "充填", detail: "充填至 220 bar，开始 5 分钟静置" });

  // TANK-231：已放行签收（历史）
  const q4 = uid("ord");
  const sheet4 = uid("sheet");
  const signedAt = now - 26 * 60 * 60 * 1000;
  state.orders[q4] = {
    id: q4,
    tankNo: "TANK-231",
    volumeL: 11.1,
    inspectUntil: date(12),
    residualBar: 60,
    targetBar: 200,
    o2Pct: 32,
    hePct: 0,
    gasKind: "高氧",
    method: "增压机",
    operator: "小周",
    createdAt: signedAt - 40 * 60 * 1000,
    stage: "released",
    reviewSheetId: null,
    sheetOpenedAt: null,
    assembly: { valveNo: "V-7650", oRingBatch: "OR-2603-C", torqueNm: 42, assembler: "老郭", at: signedAt - 25 * 60 * 1000 },
    assemblyPassed: true,
    attempts: [
      {
        valveNo: "V-7650",
        oRingBatch: "OR-2603-C",
        torqueNm: 42,
        assembler: "老郭",
        at: signedAt - 25 * 60 * 1000,
        kind: "register",
        seq: 1,
        passed: true,
        reasons: [],
      },
    ],
    filledAt: signedAt - 12 * 60 * 1000,
    release: {
      reviewer: "阿芬",
      currentBar: 199,
      dropBar: 1,
      signedAt,
      snapshot: { valveNo: "V-7650", oRingBatch: "OR-2603-C", torqueNm: 42, assembler: "老郭", at: signedAt - 25 * 60 * 1000 },
    },
    releaseVoided: false,
    voidReason: null,
  };
  pushEvent({ tankNo: "TANK-231", orderId: q4, time: signedAt - 40 * 60 * 1000, kind: "入队", detail: "11.1L 钢瓶 · EAN32 · 目标 200 bar" });
  pushEvent({ tankNo: "TANK-231", orderId: q4, time: signedAt - 35 * 60 * 1000, kind: "开单", detail: `装配复核单 ${sheet4}` });
  pushEvent({ tankNo: "TANK-231", orderId: q4, time: signedAt - 25 * 60 * 1000, kind: "复核通过", detail: "阀体 V-7650 · 扭矩 42 N·m · O 圈 OR-2603-C · 装配人 老郭" });
  pushEvent({ tankNo: "TANK-231", orderId: q4, time: signedAt - 12 * 60 * 1000, kind: "充填", detail: "充填至 200 bar，开始 5 分钟静置" });
  pushEvent({ tankNo: "TANK-231", orderId: q4, time: signedAt, kind: "放行", detail: "复核人 阿芬 · 实测 199 bar（压降 1 bar），准予放行" });

  return state;
}

// ───────────────────────── Store ─────────────────────────

type Listener = () => void;

export class FillArchive {
  private state: ArchiveState;
  private listeners = new Set<Listener>();

  constructor() {
    this.state = this.load();
    if (typeof window !== "undefined") {
      window.addEventListener("storage", (e) => {
        if (e.key === STORAGE_KEY) {
          this.state = this.load();
          this.listeners.forEach((l) => l());
        }
      });
    }
  }

  private load(): ArchiveState {
    if (typeof localStorage === "undefined") return seedState(Date.now());
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) {
        const seeded = seedState(Date.now());
        localStorage.setItem(STORAGE_KEY, JSON.stringify(seeded));
        return seeded;
      }
      const parsed = JSON.parse(raw) as ArchiveState;
      if (!parsed.orders || !parsed.events) throw new Error("bad archive");
      return parsed;
    } catch {
      return seedState(Date.now());
    }
  }

  private persist() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.state));
    } catch {
      /* 存储不可用时仅保留内存态 */
    }
  }

  private commit() {
    this.persist();
    this.listeners.forEach((l) => l());
  }

  subscribe = (l: Listener): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  getState = (): ArchiveState => this.state;

  /** 队列：未放行的单据按入队时间排序；已放行按签收时间倒序另列 */
  listOrders(): TankOrder[] {
    return Object.values(this.state.orders).sort((a, b) => a.createdAt - b.createdAt);
  }

  historyOf(tankNo: string): TimelineEvent[] {
    return [...(this.state.events[tankNo.trim().toUpperCase()] ?? [])].sort((a, b) => a.time - b.time);
  }

  findOpenOrder(tankNo: string): TankOrder | undefined {
    const key = tankNo.trim().toUpperCase();
    return this.listOrders().find((o) => o.tankNo.toUpperCase() === key && o.stage !== "released");
  }

  resetDemo() {
    this.state = seedState(Date.now());
    this.commit();
  }

  // ────────────── 写操作 ──────────────

  /** 入队；同瓶存在未结束单据时拒绝（每瓶一条活跃队列） */
  addOrder(draft: OrderDraft, now: number): { ok: true; orderId: string } | { ok: false; error: string } {
    const tankNo = draft.tankNo.trim().toUpperCase();
    if (this.findOpenOrder(tankNo)) {
      return { ok: false, error: `${tankNo} 已有未结束的充填单，完成后再登记` };
    }
    const id = uid("ord");
    const order: TankOrder = {
      id,
      tankNo,
      volumeL: draft.volumeL as number,
      inspectUntil: draft.inspectUntil,
      residualBar: draft.residualBar as number,
      targetBar: draft.targetBar as number,
      o2Pct: draft.o2Pct as number,
      hePct: draft.hePct as number,
      gasKind: gasKindOf(draft.o2Pct as number, draft.hePct as number),
      method: draft.method,
      operator: draft.operator.trim(),
      createdAt: now,
      stage: "queued",
      reviewSheetId: null,
      sheetOpenedAt: null,
      assembly: null,
      assemblyPassed: false,
      attempts: [],
      filledAt: null,
      release: null,
      releaseVoided: false,
      voidReason: null,
    };
    this.state.orders[id] = order;
    this.addEvent(tankNo, id, now, "入队", `${order.volumeL}L · ${order.gasKind} O₂ ${order.o2Pct}% / He ${order.hePct}% · 残压 ${order.residualBar} → ${order.targetBar} bar · 操作员 ${order.operator}`);
    this.commit();
    return { ok: true, orderId: id };
  }

  /**
   * 打开（或沿用）装配复核单。
   * 每瓶仅一张未结束复核单：重复或并发调用沿用首次返回的单号。
   * 放行后复核单即结束；放行失效后重新打开会领新单号。
   */
  openReviewSheet(orderId: string, now: number): string {
    const order = this.must(orderId);
    if (order.reviewSheetId) return order.reviewSheetId; // 沿用首次，不产生新单/新事件
    const sheetId = uid("sheet");
    order.reviewSheetId = sheetId;
    order.sheetOpenedAt = now;
    this.addEvent(order.tankNo, orderId, now, "开单", `装配复核单 ${sheetId}`);
    this.commit();
    return sheetId;
  }

  /**
   * 提交装配复核（首次登记或更正）。
   * 扭矩越界 / 批次过期 → 只进待检；通过 → 可充填。
   * 已充填或已放行后更正（含换阀）：充填作废需重做；已签收的放行同步失效。
   */
  submitAssembly(orderId: string, draft: AssemblyDraft, now: number): { passed: boolean; reasons: string[] } {
    const order = this.must(orderId);
    const verdict = assemblyVerdict(draft, now);
    const isRevise = order.assembly !== null;
    const rec: AssemblyRecord = {
      valveNo: draft.valveNo.trim(),
      oRingBatch: draft.oRingBatch.trim(),
      torqueNm: draft.torqueNm as number,
      assembler: draft.assembler.trim(),
      at: now,
    };

    const valveChanged = isRevise && order.assembly!.valveNo !== rec.valveNo;
    const changedDesc = isRevise
      ? `${valveChanged ? `换阀 ${order.assembly!.valveNo} → ${rec.valveNo}` : "同阀更正"} · 扭矩 ${order.assembly!.torqueNm} → ${rec.torqueNm} N·m · O 圈 ${order.assembly!.oRingBatch} → ${rec.oRingBatch} · 装配人 ${order.assembly!.assembler} → ${rec.assembler}`
      : `阀体 ${rec.valveNo} · 扭矩 ${rec.torqueNm} N·m · O 圈 ${rec.oRingBatch} · 装配人 ${rec.assembler}`;

    order.attempts.push({
      ...rec,
      kind: isRevise ? "revise" : "register",
      seq: order.attempts.length + 1,
      passed: verdict.pass,
      reasons: verdict.reasons,
    });
    order.assembly = rec;
    order.assemblyPassed = verdict.pass;

    // 更正发生在充填/放行之后：原静置与放行全部失效，须重新充填
    const afterFill = order.filledAt !== null;
    if (isRevise && afterFill) {
      order.filledAt = null;
      if (order.release) {
        order.releaseVoided = true;
        order.voidReason = `${valveChanged ? "换阀" : "更正扭矩/装配"}（${changedDesc}），原放行已签收记录失效`;
        this.addEvent(order.tankNo, orderId, now, "放行失效", order.voidReason);
        // 新的复核单保持开启（上一张已随原放行结束而关闭），在新单上继续更正与重审
      }
      this.addEvent(order.tankNo, orderId, now, "更正装配", `${changedDesc}；需重新充填静置`);
    } else if (isRevise) {
      this.addEvent(order.tankNo, orderId, now, "更正装配", changedDesc);
    }

    order.stage = verdict.pass ? "ready" : "await-check";
    this.addEvent(
      order.tankNo,
      orderId,
      now,
      verdict.pass ? "复核通过" : "转待检",
      isRevise
        ? `第 ${order.attempts.length} 次复核：${verdict.pass ? "通过，可重新充填" : verdict.reasons.join("；")}`
        : verdict.pass
          ? changedDesc
          : verdict.reasons.join("；") + "，只进待检"
    );
    this.commit();
    return { passed: verdict.pass, reasons: verdict.reasons };
  }

  /** 完成充填，开始 5 分钟静置（仅复核通过可充） */
  markFilled(orderId: string, now: number): { ok: boolean; error?: string } {
    const order = this.must(orderId);
    if (!order.assemblyPassed || order.assembly === null) {
      return { ok: false, error: "装配复核未通过，不得充填" };
    }
    order.filledAt = now;
    order.stage = "filling";
    this.addEvent(order.tankNo, orderId, now, "充填", `充填至 ${order.targetBar} bar，开始 5 分钟静置`);
    this.commit();
    return { ok: true };
  }

  /** 放行签收：静置时长、泄漏量、复核人职责分离全部硬校验 */
  signRelease(
    orderId: string,
    input: { reviewer: string; currentBar: number | null },
    now: number
  ): { ok: true } | { ok: false; reasons: string[] } {
    const order = this.must(orderId);
    if (!order.assembly) return { ok: false, reasons: ["尚无装配复核记录"] };
    const check = evaluateRelease({
      filledAt: order.filledAt,
      now,
      torqueNm: order.assembly.torqueNm,
      oRingBatch: order.assembly.oRingBatch,
      currentBar: input.currentBar,
      targetBar: order.targetBar,
      reviewer: input.reviewer,
      assembler: order.assembly.assembler,
    });
    if (!check.canSign) return { ok: false, reasons: check.reasons };

    order.release = {
      reviewer: input.reviewer.trim(),
      currentBar: input.currentBar as number,
      dropBar: order.targetBar - (input.currentBar as number),
      signedAt: now,
      snapshot: { ...order.assembly },
    };
    order.releaseVoided = false;
    order.voidReason = null;
    order.stage = "released";
    const closedSheet = order.reviewSheetId;
    // 放行签收后复核单即结束；后续换阀/更正会另开新单
    order.reviewSheetId = null;
    order.sheetOpenedAt = null;
    this.addEvent(
      order.tankNo,
      orderId,
      now,
      "放行",
      `复核人 ${input.reviewer.trim()} · 实测 ${input.currentBar} bar（压降 ${(order.targetBar - (input.currentBar as number)).toFixed(1)} bar），准予放行 · 复核单 ${closedSheet} 关闭`
    );
    this.commit();
    return { ok: true };
  }

  private must(orderId: string): TankOrder {
    const order = this.state.orders[orderId];
    if (!order) throw new Error(`订单不存在: ${orderId}`);
    return order;
  }

  private addEvent(tankNo: string, orderId: string, time: number, kind: TimelineEvent["kind"], detail: string) {
    const ev: TimelineEvent = { id: uid("evt"), tankNo, orderId, time, kind, detail };
    (this.state.events[tankNo] ??= []).push(ev);
  }
}

export const archive = new FillArchive();
