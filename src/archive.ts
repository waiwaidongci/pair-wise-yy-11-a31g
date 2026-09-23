// 存档：localStorage 持久化、跨标签页刷新同步，以及所有会改变装配/充填履历的业务命令。

import {
  AssemblyPatch,
  AuditEvent,
  ArchiveState,
  CommandResult,
  FillRecord,
  MAX_ALLOWED_LEAK_BAR,
  ReleaseRecord,
  RevisionReason,
  ReviewValues,
  AssemblyReview,
  formatDateTime,
  getFillForReview,
  getLatestReview,
  getOpenReview,
  getReleaseBlockers,
  getReviewBlockingReasons,
  restRemainingMs,
} from "./rules";

const STORAGE_KEY = "dive-tank-release-console:v1";

type MutateResult<T> = CommandResult<T>;

function makeId(prefix: string, state: ArchiveState): string {
  const random = Math.random().toString(36).slice(2, 8);
  const count =
    Object.keys(state.cylinders).length +
    state.reviews.length +
    state.fills.length +
    state.releases.length +
    state.events.length;
  return `${prefix}-${Date.now().toString(36)}-${count}-${random}`;
}

function event(
  state: ArchiveState,
  kind: AuditEvent["kind"],
  cylinderId: string,
  summary: string,
  at: number,
  reviewId?: string,
  detail?: string,
): AuditEvent {
  return {
    id: makeId("evt", state),
    at,
    kind,
    cylinderId,
    reviewId,
    summary,
    detail,
  };
}

function cloneState(state: ArchiveState): ArchiveState {
  return structuredClone(state);
}

function nextSequence(state: ArchiveState, cylinderId: string): number {
  return state.reviews.filter((review) => review.cylinderId === cylinderId).length + 1;
}

function createReview(
  state: ArchiveState,
  values: ReviewValues,
  now: number,
): AssemblyReview {
  return {
    ...values,
    cylinderId: values.cylinderId.trim().toUpperCase(),
    id: makeId("rev", state),
    sequence: nextSequence(state, values.cylinderId),
    status: "open",
    createdAt: now,
    registeredAt: now,
  };
}

function appendReviewWithPlan(
  state: ArchiveState,
  previous: AssemblyReview,
  patch: AssemblyPatch,
  now: number,
): AssemblyReview {
  return {
    ...previous,
    ...patch,
    id: makeId("rev", state),
    sequence: nextSequence(state, previous.cylinderId),
    status: "open",
    createdAt: now,
    registeredAt: now,
  };
}

export interface RegisterOutcome {
  state: ArchiveState;
  reviewId: string;
  reused: boolean;
  accepted: boolean;
}

export function registerAssemblyReview(
  current: ArchiveState,
  values: ReviewValues,
  now: number,
): MutateResult<RegisterOutcome> {
  const cylinderId = values.cylinderId.trim().toUpperCase();
  if (!cylinderId) return { ok: false, error: "请先填写气瓶编号。" };
  const normalized = { ...values, cylinderId };

  const existingOpen = getOpenReview(current, cylinderId);
  if (existingOpen) {
    return {
      ok: true,
      data: { state: current, reviewId: existingOpen.id, reused: true, accepted: false },
    };
  }

  const latest = getLatestReview(current, cylinderId);
  if (latest?.status === "released") {
    const hasValidRelease = current.releases.some(
      (release) => release.reviewId === latest.id && release.status === "valid",
    );
    if (hasValidRelease) {
      return {
        ok: false,
        error: "该瓶已有有效放行。只有换阀或更正扭矩才能生成新复核单并使原放行失效。",
      };
    }
  }

  const state = cloneState(current);
  if (!state.cylinders[cylinderId]) {
    state.cylinders[cylinderId] = {
      cylinderId,
      volumeL: normalized.volumeL,
      inspectionDue: normalized.inspectionDue,
      createdAt: now,
    };
  }

  const review = createReview(state, normalized, now);
  state.reviews.push(review);
  const reasons = getReviewBlockingReasons(review, now);
  state.events.push(
    event(
      state,
      "register",
      cylinderId,
      reasons.length > 0
        ? `第 ${review.sequence} 张装配复核单登记，进入待检`
        : `第 ${review.sequence} 张装配复核单登记，可进入充填队列`,
      now,
      review.id,
      reasons.length ? reasons.join("；") : undefined,
    ),
  );

  return {
    ok: true,
    data: { state, reviewId: review.id, reused: false, accepted: reasons.length === 0 },
  };
}

export interface PatchOutcome {
  state: ArchiveState;
  reviewId: string;
  accepted: boolean;
}

export function correctOpenAssembly(
  current: ArchiveState,
  reviewId: string,
  patch: AssemblyPatch,
  now: number,
): MutateResult<PatchOutcome> {
  const review = current.reviews.find((item) => item.id === reviewId);
  if (!review || review.status !== "open") {
    return { ok: false, error: "只能更正当前未结束的装配复核单。" };
  }
  const existingFill = getFillForReview(current, reviewId);
  if (existingFill) {
    return {
      ok: false,
      error: "已完成充填后不能直接覆盖原单；请使用换阀或更正扭矩生成接替复核单。",
    };
  }

  const state = cloneState(current);
  const target = state.reviews.find((item) => item.id === reviewId)!;
  const before = `${target.valveBodyNo} / ${target.oRingBatch} / ${target.torqueNm ?? "-"} N·m / ${target.assembler}`;
  Object.assign(target, patch);
  const reasons = getReviewBlockingReasons(target, now);
  target.status = "open";

  state.events.push(
    event(
      state,
      "correct",
      target.cylinderId,
      reasons.length ? "装配信息已更正，仍为待检" : "装配信息已更正，可进入充填队列",
      now,
      target.id,
      `原记录：${before}；${reasons.length ? reasons.join("；") : "复核条件通过"}`,
    ),
  );

  return { ok: true, data: { state, reviewId, accepted: reasons.length === 0 } };
}

export interface RevisionOutcome {
  state: ArchiveState;
  reviewId: string;
  accepted: boolean;
  invalidatedReleaseId?: string;
}

export function replaceOrCorrectAssembly(
  current: ArchiveState,
  previousReviewId: string,
  reason: RevisionReason,
  patch: AssemblyPatch,
  now: number,
): MutateResult<RevisionOutcome> {
  const previous = current.reviews.find((item) => item.id === previousReviewId);
  if (!previous) return { ok: false, error: "未找到原装配复核单。" };
  if (previous.id !== getLatestReview(current, previous.cylinderId)?.id) {
    return { ok: false, error: "只能对每瓶最新复核单发起换阀或扭矩更正。" };
  }
  if (previous.status === "superseded") {
    return { ok: false, error: "原复核单已被接替，请使用当前未结束复核单。" };
  }

  const fill = getFillForReview(current, previous.id);
  if (fill) {
    const remaining = restRemainingMs(fill, now);
    if (remaining > 0) {
      return { ok: false, error: "五分钟静置期间不得换阀或更正扭矩。" };
    }
    if (fill.leakLossBar === null) {
      return { ok: false, error: "请先完成泄漏复核，再按结果决定是否返修。" };
    }
    if (
      fill.leakLossBar <= MAX_ALLOWED_LEAK_BAR &&
      previous.status === "open" &&
      reason === "torque-correction"
    ) {
      return { ok: false, error: "泄漏复核合格时应由不同复核人签收，不能再更正扭矩。" };
    }
  }

  if (reason === "valve-replacement" && patch.valveBodyNo.trim() === previous.valveBodyNo) {
    return { ok: false, error: "换阀必须登记与原阀体不同的阀体号。" };
  }
  if (reason === "torque-correction") {
    if (patch.torqueNm === null) return { ok: false, error: "请输入更正后的扭矩。" };
    if (patch.torqueNm === previous.torqueNm) {
      return { ok: false, error: "更正后的扭矩与原扭矩相同。" };
    }
  }

  const state = cloneState(current);
  const oldReview = state.reviews.find((item) => item.id === previousReviewId)!;
  oldReview.status = "superseded";

  const newReview = appendReviewWithPlan(state, oldReview, patch, now);
  state.reviews.push(newReview);
  const reasons = getReviewBlockingReasons(newReview, now);

  const validRelease = state.releases.find(
    (release) => release.reviewId === oldReview.id && release.status === "valid",
  );
  let invalidatedReleaseId: string | undefined;
  if (validRelease) {
    validRelease.status = "invalidated";
    validRelease.invalidReason = reason;
    validRelease.invalidatedAt = now;
    invalidatedReleaseId = validRelease.id;
    state.events.push(
      event(
        state,
        "invalidate",
        oldReview.cylinderId,
        reason === "valve-replacement" ? "更换阀体，原放行失效" : "更正阀颈扭矩，原放行失效",
        now,
        oldReview.id,
        `原放行单 ${validRelease.id}；签收时间 ${formatDateTime(validRelease.signedAt)}`,
      ),
    );
  }

  state.events.push(
    event(
      state,
      "register",
      newReview.cylinderId,
      reason === "valve-replacement"
        ? `第 ${newReview.sequence} 张复核单已按换阀生成`
        : `第 ${newReview.sequence} 张复核单已按扭矩更正生成`,
      now,
      newReview.id,
      reasons.length ? `当前为待检：${reasons.join("；")}` : "当前可重新充填",
    ),
  );

  return {
    ok: true,
    data: { state, reviewId: newReview.id, accepted: reasons.length === 0, invalidatedReleaseId },
  };
}

export function completeFill(
  current: ArchiveState,
  reviewId: string,
  now: number,
): MutateResult<{ state: ArchiveState; fillId: string }> {
  const review = current.reviews.find((item) => item.id === reviewId);
  if (!review || review.status !== "open") {
    return { ok: false, error: "未找到可充填的未结束复核单。" };
  }
  if (getFillForReview(current, reviewId)) {
    return { ok: false, error: "该复核单已完成充填，不能重复开始。" };
  }
  const reasons = getReviewBlockingReasons(review, now);
  if (reasons.length) {
    return { ok: false, error: `仍处于待检：${reasons.join("；")}` };
  }

  const state = cloneState(current);
  const fill: FillRecord = {
    id: makeId("fill", state),
    reviewId,
    cylinderId: review.cylinderId,
    filledAt: now,
    volumeL: review.volumeL,
    inspectionDue: review.inspectionDue,
    residualPressureBar: review.residualPressureBar,
    targetPressureBar: review.targetPressureBar,
    oxygenPercent: review.oxygenPercent,
    heliumPercent: review.heliumPercent,
    method: review.method,
    operator: review.operator,
    leakLossBar: null,
    measuredAt: null,
  };
  state.fills.push(fill);
  state.events.push(
    event(
      state,
      "fill",
      review.cylinderId,
      `充填完成，开始静置五分钟（目标 ${review.targetPressureBar ?? "-"} bar）`,
      now,
      reviewId,
      `完成时间 ${formatDateTime(now)}`,
    ),
  );

  return { ok: true, data: { state, fillId: fill.id } };
}

export function recordLeak(
  current: ArchiveState,
  reviewId: string,
  leakLossBar: number,
  now: number,
): MutateResult<{ state: ArchiveState; accepted: boolean }> {
  const review = current.reviews.find((item) => item.id === reviewId);
  if (!review || review.status !== "open") {
    return { ok: false, error: "只能在未结束复核单上登记泄漏复核。" };
  }
  const fill = getFillForReview(current, reviewId);
  if (!fill) return { ok: false, error: "尚未完成充填。" };
  const remaining = restRemainingMs(fill, now);
  if (remaining > 0) return { ok: false, error: `仍需静置 ${Math.ceil(remaining / 1000)} 秒。` };
  if (!Number.isFinite(leakLossBar) || leakLossBar < 0) {
    return { ok: false, error: "请输入不小于 0 bar 的五分钟压降。" };
  }

  const state = cloneState(current);
  const targetFill = state.fills.find((item) => item.id === fill.id)!;
  targetFill.leakLossBar = leakLossBar;
  targetFill.measuredAt = now;
  const accepted = leakLossBar <= MAX_ALLOWED_LEAK_BAR;
  state.events.push(
    event(
      state,
      "leak",
      review.cylinderId,
      accepted
        ? `泄漏复核 ${leakLossBar} bar，未超过 ${MAX_ALLOWED_LEAK_BAR} bar`
        : `泄漏复核 ${leakLossBar} bar，超过 ${MAX_ALLOWED_LEAK_BAR} bar，扣留待返修`,
      now,
      reviewId,
    ),
  );

  return { ok: true, data: { state, accepted } };
}

export function releaseFill(
  current: ArchiveState,
  reviewId: string,
  reviewer: string,
  now: number,
): MutateResult<{ state: ArchiveState; releaseId: string }> {
  const review = current.reviews.find((item) => item.id === reviewId);
  if (!review || review.status !== "open") {
    return { ok: false, error: "复核单已结束，不能签收。" };
  }
  const fill = getFillForReview(current, reviewId);
  const blockers = getReleaseBlockers(review, fill, reviewer, now);
  if (blockers.length) return { ok: false, error: blockers.join("；") };
  if (current.releases.some((release) => release.reviewId === reviewId && release.status === "valid")) {
    return { ok: false, error: "该复核单已经有有效放行签收。" };
  }

  const state = cloneState(current);
  const targetReview = state.reviews.find((item) => item.id === reviewId)!;
  const targetFill = state.fills.find((item) => item.reviewId === reviewId)!;
  const release: ReleaseRecord = {
    id: makeId("rel", state),
    reviewId,
    cylinderId: review.cylinderId,
    signedAt: now,
    reviewer: reviewer.trim(),
    leakLossBar: targetFill.leakLossBar ?? 0,
    status: "valid",
  };
  state.releases.push(release);
  targetReview.status = "released";
  state.events.push(
    event(
      state,
      "release",
      review.cylinderId,
      `放行签收：复核人 ${release.reviewer}`,
      now,
      reviewId,
      `泄漏压降 ${release.leakLossBar} bar；放行单 ${release.id}`,
    ),
  );

  return { ok: true, data: { state, releaseId: release.id } };
}

function createSeedState(now: number): ArchiveState {
  const state: ArchiveState = {
    cylinders: {
      "TANK-204": {
        cylinderId: "TANK-204",
        volumeL: 12,
        inspectionDue: "2027-05-18",
        createdAt: now - 3 * 86_400_000,
      },
      "TANK-219": {
        cylinderId: "TANK-219",
        volumeL: 11,
        inspectionDue: "2027-02-09",
        createdAt: now - 2 * 86_400_000,
      },
      "TANK-231": {
        cylinderId: "TANK-231",
        volumeL: 24,
        inspectionDue: "2026-10-06",
        createdAt: now - 86_400_000,
      },
    },
    reviews: [],
    fills: [],
    releases: [],
    events: [],
  };

  const readyReview: AssemblyReview = {
    id: "rev-seed-204",
    sequence: 1,
    status: "open",
    createdAt: now - 30 * 60_000,
    registeredAt: now - 30 * 60_000,
    cylinderId: "TANK-204",
    volumeL: 12,
    inspectionDue: "2027-05-18",
    residualPressureBar: 55,
    targetPressureBar: 200,
    oxygenPercent: 21,
    heliumPercent: 0,
    method: "空气充填",
    operator: "林舟",
    valveBodyNo: "V-77A204",
    oRingBatch: "OR-2608",
    oRingExpiry: "2027-08-31",
    torqueNm: 40,
    assembler: "赵岭",
  };

  const releasedReview: AssemblyReview = {
    id: "rev-seed-219",
    sequence: 1,
    status: "released",
    createdAt: now - 25 * 60 * 60_000,
    registeredAt: now - 25 * 60 * 60_000,
    cylinderId: "TANK-219",
    volumeL: 11,
    inspectionDue: "2027-02-09",
    residualPressureBar: 40,
    targetPressureBar: 210,
    oxygenPercent: 32,
    heliumPercent: 0,
    method: "高氧充填",
    operator: "林舟",
    valveBodyNo: "V-63C219",
    oRingBatch: "OR-2602",
    oRingExpiry: "2027-03-31",
    torqueNm: 38,
    assembler: "赵岭",
  };

  const restingReview: AssemblyReview = {
    id: "rev-seed-231",
    sequence: 1,
    status: "open",
    createdAt: now - 6 * 60_000,
    registeredAt: now - 6 * 60_000,
    cylinderId: "TANK-231",
    volumeL: 24,
    inspectionDue: "2026-10-06",
    residualPressureBar: 60,
    targetPressureBar: 220,
    oxygenPercent: 18,
    heliumPercent: 35,
    method: "Trimix充填",
    operator: "陈潜",
    valveBodyNo: "V-91D231",
    oRingBatch: "OR-2607",
    oRingExpiry: "2027-01-31",
    torqueNm: 42,
    assembler: "周潮",
  };

  state.reviews.push(readyReview, releasedReview, restingReview);

  state.fills.push(
    {
      id: "fill-seed-219",
      reviewId: releasedReview.id,
      cylinderId: "TANK-219",
      filledAt: now - 24 * 60 * 60_000,
      volumeL: 11,
      inspectionDue: "2027-02-09",
      residualPressureBar: 40,
      targetPressureBar: 210,
      oxygenPercent: 32,
      heliumPercent: 0,
      method: "高氧充填",
      operator: "林舟",
      leakLossBar: 1,
      measuredAt: now - 24 * 60 * 60_000 + 5 * 60_000,
    },
    {
      id: "fill-seed-231",
      reviewId: restingReview.id,
      cylinderId: "TANK-231",
      filledAt: now - 2 * 60_000,
      volumeL: 24,
      inspectionDue: "2026-10-06",
      residualPressureBar: 60,
      targetPressureBar: 220,
      oxygenPercent: 18,
      heliumPercent: 35,
      method: "Trimix充填",
      operator: "陈潜",
      leakLossBar: null,
      measuredAt: null,
    },
  );

  state.releases.push({
    id: "rel-seed-219",
    reviewId: releasedReview.id,
    cylinderId: "TANK-219",
    signedAt: now - 24 * 60 * 60_000 + 6 * 60_000,
    reviewer: "许衡",
    leakLossBar: 1,
    status: "valid",
  });

  state.events.push(
    event(state, "register", "TANK-204", "第 1 张装配复核单登记，可进入充填队列", readyReview.registeredAt, readyReview.id),
    event(state, "register", "TANK-219", "第 1 张装配复核单登记，可进入充填队列", releasedReview.registeredAt, releasedReview.id),
    event(state, "fill", "TANK-219", "充填完成，开始静置五分钟（目标 210 bar）", now - 24 * 60 * 60_000, releasedReview.id),
    event(state, "leak", "TANK-219", "泄漏复核 1 bar，未超过 3 bar", now - 24 * 60 * 60_000 + 5 * 60_000, releasedReview.id),
    event(state, "release", "TANK-219", "放行签收：复核人 许衡", now - 24 * 60 * 60_000 + 6 * 60_000, releasedReview.id),
    event(state, "register", "TANK-231", "第 1 张装配复核单登记，可进入充填队列", restingReview.registeredAt, restingReview.id),
    event(state, "fill", "TANK-231", "充填完成，开始静置五分钟（目标 220 bar）", now - 2 * 60_000, restingReview.id),
  );

  return state;
}

function loadState(): ArchiveState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      const seeded = createSeedState(Date.now());
      localStorage.setItem(STORAGE_KEY, JSON.stringify(seeded));
      return seeded;
    }
    const parsed = JSON.parse(raw) as ArchiveState;
    if (!parsed.cylinders || !Array.isArray(parsed.reviews) || !Array.isArray(parsed.events)) {
      throw new Error("invalid archive");
    }
    return parsed;
  } catch (error) {
    console.warn("存档读取失败，已重建演示数据。", error);
    return createSeedState(Date.now());
  }
}

class ArchiveStore {
  private state: ArchiveState;
  private subscribers = new Set<(state: ArchiveState) => void>();

  constructor() {
    this.state = loadState();
    if (typeof window !== "undefined") {
      window.addEventListener("storage", this.handleStorage);
    }
  }

  private handleStorage = (event: StorageEvent) => {
    if (event.key !== STORAGE_KEY || !event.newValue) return;
    try {
      const next = JSON.parse(event.newValue) as ArchiveState;
      this.state = next;
      this.subscribers.forEach((subscriber) => subscriber(next));
    } catch {
      // 保留当前标签页的有效状态，等待下一次有效写入。
    }
  };

  getState(): ArchiveState {
    return this.state;
  }

  subscribe(subscriber: (state: ArchiveState) => void): () => void {
    this.subscribers.add(subscriber);
    return () => this.subscribers.delete(subscriber);
  }

  private readPersistedState(): ArchiveState | null {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as ArchiveState;
      if (!parsed.cylinders || !Array.isArray(parsed.reviews) || !Array.isArray(parsed.events)) {
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }

  private syncFromStorage(): ArchiveState {
    const persisted = this.readPersistedState();
    if (persisted) this.state = persisted;
    return this.state;
  }

  mutate<T>(
    command: (state: ArchiveState, now: number) => CommandResult<T & { state: ArchiveState }>,
    now = Date.now(),
  ): CommandResult<T> {
    const fresh = this.syncFromStorage();
    const result = command(fresh, now);
    if (!result.ok) return result;
    const { state: next, ...data } = result.data as T & { state: ArchiveState };
    this.commit(next);
    return { ok: true, data: data as T };
  }

  commit(next: ArchiveState) {
    this.state = next;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch (error) {
      console.warn("存档写入失败，当前标签页仍保留本次操作。", error);
    }
    this.subscribers.forEach((subscriber) => subscriber(next));
  }

  register(values: ReviewValues, now = Date.now()) {
    return this.mutate<Omit<RegisterOutcome, "state">>((state, at) =>
      registerAssemblyReview(state, values, at), now);
  }

  completeFill(reviewId: string, now = Date.now()) {
    return this.mutate<{ fillId: string }>((state, at) => completeFill(state, reviewId, at), now);
  }

  recordLeak(reviewId: string, leakLossBar: number, now = Date.now()) {
    return this.mutate<{ accepted: boolean }>((state, at) =>
      recordLeak(state, reviewId, leakLossBar, at), now);
  }

  releaseFill(reviewId: string, reviewer: string, now = Date.now()) {
    return this.mutate<{ releaseId: string }>((state, at) =>
      releaseFill(state, reviewId, reviewer, at), now);
  }

  correctOpenAssembly(reviewId: string, patch: AssemblyPatch, now = Date.now()) {
    return this.mutate<Omit<PatchOutcome, "state">>((state, at) =>
      correctOpenAssembly(state, reviewId, patch, at), now);
  }

  replaceOrCorrectAssembly(
    reviewId: string,
    reason: RevisionReason,
    patch: AssemblyPatch,
    now = Date.now(),
  ) {
    return this.mutate<Omit<RevisionOutcome, "state">>((state, at) =>
      replaceOrCorrectAssembly(state, reviewId, reason, patch, at), now);
  }

  resetDemo(now = Date.now()): ArchiveState {
    const next = createSeedState(now);
    this.commit(next);
    return next;
  }
}

export const archiveStore = new ArchiveStore();

export { STORAGE_KEY, createSeedState };
