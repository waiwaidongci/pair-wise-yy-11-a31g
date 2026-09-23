// 业务规则：阀颈扭矩复核、静置泄漏复核与放行判定。本文件保持为纯函数，便于复核和复用。

export const TORQUE_MIN_NM = 35;
export const TORQUE_MAX_NM = 45;
export const REST_AFTER_FILL_MS = 5 * 60 * 1000;
export const MAX_ALLOWED_LEAK_BAR = 3;
export const INSPECTION_WARNING_DAYS = 14;

export type FillMethod = "空气充填" | "高氧充填" | "Trimix充填";
export type QueueStatus =
  | "ready"
  | "quarantine"
  | "resting"
  | "release"
  | "leak-hold"
  | "released"
  | "invalidated";

export type RevisionReason = "valve-replacement" | "torque-correction";

export type NumberInput = number | null;

export interface ReviewValues {
  cylinderId: string;
  volumeL: NumberInput;
  inspectionDue: string;
  residualPressureBar: NumberInput;
  targetPressureBar: NumberInput;
  oxygenPercent: NumberInput;
  heliumPercent: NumberInput;
  method: FillMethod;
  operator: string;
  valveBodyNo: string;
  oRingBatch: string;
  oRingExpiry: string;
  torqueNm: NumberInput;
  assembler: string;
}

export interface AssemblyPatch {
  valveBodyNo: string;
  oRingBatch: string;
  oRingExpiry: string;
  torqueNm: NumberInput;
  assembler: string;
}

export type ReviewStatus = "open" | "released" | "superseded";

export interface CylinderRecord {
  cylinderId: string;
  volumeL: NumberInput;
  inspectionDue: string;
  createdAt: number;
}

export interface AssemblyReview extends ReviewValues {
  id: string;
  sequence: number;
  status: ReviewStatus;
  createdAt: number;
  registeredAt: number;
}

export interface FillRecord {
  id: string;
  reviewId: string;
  cylinderId: string;
  filledAt: number;
  volumeL: NumberInput;
  inspectionDue: string;
  residualPressureBar: NumberInput;
  targetPressureBar: NumberInput;
  oxygenPercent: NumberInput;
  heliumPercent: NumberInput;
  method: FillMethod;
  operator: string;
  leakLossBar: number | null;
  measuredAt: number | null;
}

export type ReleaseStatus = "valid" | "invalidated";

export interface ReleaseRecord {
  id: string;
  reviewId: string;
  cylinderId: string;
  signedAt: number;
  reviewer: string;
  leakLossBar: number;
  status: ReleaseStatus;
  invalidReason?: RevisionReason;
  invalidatedAt?: number;
}

export type AuditKind =
  | "register"
  | "correct"
  | "fill"
  | "leak"
  | "release"
  | "invalidate"
  | "reopen";

export interface AuditEvent {
  id: string;
  at: number;
  cylinderId: string;
  reviewId?: string;
  kind: AuditKind;
  summary: string;
  detail?: string;
}

export interface ArchiveState {
  cylinders: Record<string, CylinderRecord>;
  reviews: AssemblyReview[];
  fills: FillRecord[];
  releases: ReleaseRecord[];
  events: AuditEvent[];
}

export interface QueueItem {
  cylinder: CylinderRecord;
  review: AssemblyReview;
  fill?: FillRecord;
  release?: ReleaseRecord;
  status: QueueStatus;
  reasons: string[];
  restRemainingMs: number;
}

export type CommandResult<T = { reviewId: string; reused: boolean }> =
  | { ok: true; data: T }
  | { ok: false; error: string };

export const STATUS_LABELS: Record<QueueStatus, string> = {
  ready: "待充填",
  quarantine: "待检",
  resting: "静置中",
  release: "待放行",
  "leak-hold": "泄漏扣留",
  released: "已放行",
  invalidated: "放行失效",
};

export const FILL_METHODS: FillMethod[] = ["空气充填", "高氧充填", "Trimix充填"];

export function parseNumber(value: string | number | null | undefined): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (value === null || value === undefined || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function normalizeCylinderId(value: string): string {
  return value.trim().toUpperCase();
}

export function normalizePerson(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

export function isSamePerson(a: string, b: string): boolean {
  const left = normalizePerson(a);
  const right = normalizePerson(b);
  return left !== "" && left === right;
}

function endOfDay(dateValue: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateValue);
  if (!match) return Number.NaN;
  return new Date(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    23,
    59,
    59,
    999,
  ).getTime();
}

function startOfDay(timestamp: number): number {
  const date = new Date(timestamp);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

export function isDateExpired(dateValue: string, now: number): boolean {
  const end = endOfDay(dateValue);
  return Number.isNaN(end) || end < now;
}

export function daysUntilDate(dateValue: string, now: number): number | null {
  const end = endOfDay(dateValue);
  if (Number.isNaN(end)) return null;
  return Math.round((startOfDay(end) - startOfDay(now)) / 86_400_000);
}

export function inspectionAdvice(dateValue: string, now: number): string | null {
  if (!dateValue) return "未登记气瓶检验有效期";
  const days = daysUntilDate(dateValue, now);
  if (days === null) return "检验有效期格式不正确";
  if (days < 0) return `气瓶检验已过期 ${Math.abs(days)} 天`;
  if (days === 0) return "气瓶检验今天到期";
  if (days <= INSPECTION_WARNING_DAYS) return `气瓶检验有效期剩余 ${days} 天`;
  return null;
}

export function assemblyExceptionReasons(
  values: Pick<
    ReviewValues,
    "valveBodyNo" | "oRingBatch" | "oRingExpiry" | "torqueNm" | "assembler"
  >,
  now: number,
): string[] {
  const reasons: string[] = [];

  if (!values.valveBodyNo.trim()) reasons.push("未登记阀体号");
  if (!values.oRingBatch.trim()) reasons.push("未登记 O 型圈批次");
  if (!values.oRingExpiry.trim()) {
    reasons.push("未登记 O 型圈批次有效期");
  } else if (isDateExpired(values.oRingExpiry, now)) {
    reasons.push(`O 型圈批次已于 ${values.oRingExpiry} 过期`);
  }

  if (values.torqueNm === null) {
    reasons.push("未登记阀颈扭矩");
  } else if (
    values.torqueNm < TORQUE_MIN_NM ||
    values.torqueNm > TORQUE_MAX_NM
  ) {
    reasons.push(
      `阀颈扭矩 ${values.torqueNm} N·m 不在 ${TORQUE_MIN_NM} 至 ${TORQUE_MAX_NM} N·m 范围`,
    );
  }

  if (!values.assembler.trim()) reasons.push("未登记装配人");
  return reasons;
}

export function cylinderExceptionReasons(
  values: Pick<ReviewValues, "cylinderId" | "volumeL" | "inspectionDue">,
  now: number,
): string[] {
  const reasons: string[] = [];
  if (!values.cylinderId.trim()) reasons.push("未登记气瓶编号");
  if (values.volumeL === null || values.volumeL <= 0) {
    reasons.push("气瓶容积必须大于 0 L");
  }
  const inspection = inspectionAdvice(values.inspectionDue, now);
  if (inspection && (!inspection.startsWith("气瓶检验有效期剩余"))) {
    reasons.push(inspection);
  }
  return reasons;
}

export function fillPlanExceptionReasons(
  values: Pick<
    ReviewValues,
    | "residualPressureBar"
    | "targetPressureBar"
    | "oxygenPercent"
    | "heliumPercent"
    | "operator"
  >,
): string[] {
  const reasons: string[] = [];
  if (values.residualPressureBar === null || values.residualPressureBar < 0) {
    reasons.push("残压不能为负数");
  }
  if (
    values.targetPressureBar === null ||
    values.residualPressureBar === null ||
    values.targetPressureBar <= values.residualPressureBar
  ) {
    reasons.push("目标压力必须高于残压");
  }
  if (
    values.oxygenPercent === null ||
    values.oxygenPercent < 0 ||
    values.oxygenPercent > 100
  ) {
    reasons.push("氧含量必须在 0 至 100% 之间");
  }
  if (
    values.heliumPercent === null ||
    values.heliumPercent < 0 ||
    values.heliumPercent > 100
  ) {
    reasons.push("氦含量必须在 0 至 100% 之间");
  }
  if (
    values.oxygenPercent !== null &&
    values.heliumPercent !== null &&
    values.oxygenPercent + values.heliumPercent > 100
  ) {
    reasons.push("氧含量与氦含量合计不能超过 100%");
  }
  if (!values.operator.trim()) reasons.push("未登记充填操作员");
  return reasons;
}

export function getReviewBlockingReasons(review: ReviewValues, now: number): string[] {
  return [
    ...assemblyExceptionReasons(review, now),
    ...cylinderExceptionReasons(review, now),
    ...fillPlanExceptionReasons(review),
  ];
}

export function gasMixSummary(
  values: Pick<ReviewValues, "method" | "oxygenPercent" | "heliumPercent">,
): string {
  const { oxygenPercent: oxygen, heliumPercent: helium, method } = values;
  if (oxygen === null || helium === null) return "请填写氧含量和氦含量";
  if (oxygen < 0 || helium < 0 || oxygen + helium > 100) {
    return "混合气比例无效：氧含量与氦含量合计不能超过 100%";
  }

  const nitrogen = Math.round((100 - oxygen - helium) * 10) / 10;
  const mod = oxygen > 0 ? Math.max(0, Math.round((1.4 / (oxygen / 100) - 1) * 10)) : 0;
  let warning = "";

  if (method === "空气充填" && (oxygen !== 21 || helium !== 0)) {
    warning = "；空气方式通常应为 O₂ 21% / He 0%";
  }
  if (method === "高氧充填" && (oxygen <= 21 || oxygen > 40 || helium !== 0)) {
    warning = "；高氧方式通常为 22–40% O₂ 且 He 0%";
  }
  if (method === "Trimix充填" && (helium <= 0 || oxygen < 12 || oxygen > 50)) {
    warning = "；Trimix 通常含氦，O₂ 常设在 12–50%";
  }

  return `${method}：O₂ ${oxygen}% / He ${helium}% / N₂ ${nitrogen}%；1.4 ata MOD≈${mod}m${warning}`;
}

export function getOpenReview(state: ArchiveState, cylinderId: string) {
  return state.reviews.find(
    (review) => review.cylinderId === cylinderId && review.status === "open",
  );
}

export function getLatestReview(state: ArchiveState, cylinderId: string) {
  return state.reviews
    .filter((review) => review.cylinderId === cylinderId)
    .sort((a, b) => b.sequence - a.sequence)[0];
}

export function getFillForReview(state: ArchiveState, reviewId: string) {
  return state.fills.find((fill) => fill.reviewId === reviewId);
}

export function getValidRelease(state: ArchiveState, reviewId: string) {
  return state.releases.find(
    (release) => release.reviewId === reviewId && release.status === "valid",
  );
}

export function restRemainingMs(fill: FillRecord, now: number): number {
  return Math.max(0, fill.filledAt + REST_AFTER_FILL_MS - now);
}

export function getReleaseBlockers(
  review: AssemblyReview,
  fill: FillRecord | undefined,
  reviewer: string,
  now: number,
): string[] {
  const blockers: string[] = [];
  if (!fill) {
    blockers.push("尚未完成充填");
    return blockers;
  }

  const remaining = restRemainingMs(fill, now);
  if (remaining > 0) {
    blockers.push(`充填后需静置满五分钟，还剩 ${formatRemaining(remaining)}`);
  }
  if (fill.leakLossBar === null) {
    blockers.push("尚未登记静置后的泄漏压降");
  } else if (fill.leakLossBar > MAX_ALLOWED_LEAK_BAR) {
    blockers.push(
      `五分钟压降 ${fill.leakLossBar} bar，超过 ${MAX_ALLOWED_LEAK_BAR} bar，禁止签收`,
    );
  }
  if (!reviewer.trim()) {
    blockers.push("请填写放行复核人");
  } else if (isSamePerson(reviewer, review.assembler)) {
    blockers.push("放行复核人不得与装配人相同");
  }
  return blockers;
}

export function buildQueue(state: ArchiveState, now: number): QueueItem[] {
  const items = Object.keys(state.cylinders).map((cylinderId) => {
    const cylinder = state.cylinders[cylinderId];
    const review = getLatestReview(state, cylinderId);

    if (!review) {
      const fallback: AssemblyReview = {
        id: "missing",
        sequence: 0,
        status: "superseded",
        createdAt: cylinder.createdAt,
        registeredAt: cylinder.createdAt,
        cylinderId,
        volumeL: cylinder.volumeL,
        inspectionDue: cylinder.inspectionDue,
        residualPressureBar: null,
        targetPressureBar: null,
        oxygenPercent: null,
        heliumPercent: null,
        method: "空气充填",
        operator: "",
        valveBodyNo: "",
        oRingBatch: "",
        oRingExpiry: "",
        torqueNm: null,
        assembler: "",
      };
      return {
        cylinder,
        review: fallback,
        status: "invalidated" as const,
        reasons: ["缺少装配复核单"],
        restRemainingMs: 0,
      };
    }

    const fill = getFillForReview(state, review.id);
    const release = state.releases.reduce<ReleaseRecord | undefined>(
      (found, item) => (item.reviewId === review.id ? item : found),
      undefined,
    );
    const reasons = getReviewBlockingReasons(review, now);
    const restRemaining = fill ? restRemainingMs(fill, now) : 0;

    let status: QueueStatus;
    if (review.status === "open") {
      if (!fill) {
        status = reasons.length > 0 ? "quarantine" : "ready";
      } else if (restRemaining > 0) {
        status = "resting";
      } else if (fill.leakLossBar === null) {
        status = "release";
      } else if (fill.leakLossBar > MAX_ALLOWED_LEAK_BAR) {
        status = "leak-hold";
      } else {
        status = "release";
      }
    } else if (review.status === "released" && release?.status === "valid") {
      status = "released";
    } else {
      status = "invalidated";
    }

    return { cylinder, review, fill, release, status, reasons, restRemainingMs: restRemaining };
  });

  const weights: Record<QueueStatus, number> = {
    quarantine: 0,
    "leak-hold": 1,
    resting: 2,
    release: 3,
    ready: 4,
    invalidated: 5,
    released: 6,
  };

  return items.sort(
    (a, b) =>
      weights[a.status] - weights[b.status] ||
      a.review.registeredAt - b.review.registeredAt ||
      a.cylinder.cylinderId.localeCompare(b.cylinder.cylinderId),
  );
}

export function getCylinderHistory(state: ArchiveState, cylinderId: string): AuditEvent[] {
  return state.events
    .filter((event) => event.cylinderId === cylinderId)
    .sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
}

export function formatRemaining(ms: number): string {
  const totalSeconds = Math.ceil(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export function formatDateTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString("zh-CN", { hour12: false });
}

export function formatDateInput(date: Date): string {
  return date.toISOString().slice(0, 10);
}
