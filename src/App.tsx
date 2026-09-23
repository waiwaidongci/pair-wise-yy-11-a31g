// 界面：登记装配复核、队列操作、充填后泄漏复核、单瓶履历与跨标签页状态同步。

import { ChangeEvent, FormEvent, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { archiveStore } from "./archive";
import {
  AssemblyPatch,
  FILL_METHODS,
  FillMethod,
  QueueStatus,
  ReviewValues,
  RevisionReason,
  STATUS_LABELS,
  TORQUE_MAX_NM,
  TORQUE_MIN_NM,
  MAX_ALLOWED_LEAK_BAR,
  buildQueue,
  formatDateInput,
  formatDateTime,
  formatRemaining,
  gasMixSummary,
  getCylinderHistory,
  getReleaseBlockers,
  getReviewBlockingReasons,
  inspectionAdvice,
  isSamePerson,
  parseNumber,
} from "./rules";
import "./styles.css";

interface FormState {
  cylinderId: string;
  volumeL: string;
  inspectionDue: string;
  residualPressureBar: string;
  targetPressureBar: string;
  oxygenPercent: string;
  heliumPercent: string;
  method: FillMethod;
  operator: string;
  valveBodyNo: string;
  oRingBatch: string;
  oRingExpiry: string;
  torqueNm: string;
  assembler: string;
}

type EditMode = "edit" | "valve" | "torque";

type Notice = { type: "ok" | "warn" | "error"; text: string } | null;

const AUDIT_LABELS = {
  register: "装配登记",
  correct: "装配更正",
  fill: "充填",
  leak: "泄漏复核",
  release: "放行签收",
  invalidate: "放行失效",
  reopen: "重新启用",
} as const;

function oneYearFromToday(): string {
  const date = new Date();
  date.setFullYear(date.getFullYear() + 1);
  return formatDateInput(date);
}

function emptyForm(): FormState {
  return {
    cylinderId: "",
    volumeL: "12",
    inspectionDue: oneYearFromToday(),
    residualPressureBar: "50",
    targetPressureBar: "200",
    oxygenPercent: "21",
    heliumPercent: "0",
    method: "空气充填",
    operator: "",
    valveBodyNo: "",
    oRingBatch: "",
    oRingExpiry: oneYearFromToday(),
    torqueNm: "",
    assembler: "",
  };
}

function valuesFromForm(form: FormState): ReviewValues {
  return {
    cylinderId: form.cylinderId.trim().toUpperCase(),
    volumeL: parseNumber(form.volumeL),
    inspectionDue: form.inspectionDue,
    residualPressureBar: parseNumber(form.residualPressureBar),
    targetPressureBar: parseNumber(form.targetPressureBar),
    oxygenPercent: parseNumber(form.oxygenPercent),
    heliumPercent: parseNumber(form.heliumPercent),
    method: form.method,
    operator: form.operator,
    valveBodyNo: form.valveBodyNo.trim(),
    oRingBatch: form.oRingBatch.trim(),
    oRingExpiry: form.oRingExpiry,
    torqueNm: parseNumber(form.torqueNm),
    assembler: form.assembler.trim(),
  };
}

function formFromReview(review: ReviewValues): FormState {
  const stringify = (value: number | null) => (value === null ? "" : String(value));
  return {
    cylinderId: review.cylinderId,
    volumeL: stringify(review.volumeL),
    inspectionDue: review.inspectionDue,
    residualPressureBar: stringify(review.residualPressureBar),
    targetPressureBar: stringify(review.targetPressureBar),
    oxygenPercent: stringify(review.oxygenPercent),
    heliumPercent: stringify(review.heliumPercent),
    method: review.method,
    operator: review.operator,
    valveBodyNo: review.valveBodyNo,
    oRingBatch: review.oRingBatch,
    oRingExpiry: review.oRingExpiry,
    torqueNm: stringify(review.torqueNm),
    assembler: review.assembler,
  };
}

function patchFromForm(form: FormState): AssemblyPatch {
  return {
    valveBodyNo: form.valveBodyNo.trim(),
    oRingBatch: form.oRingBatch.trim(),
    oRingExpiry: form.oRingExpiry,
    torqueNm: parseNumber(form.torqueNm),
    assembler: form.assembler.trim(),
  };
}

function App() {
  const state = useSyncExternalStore(
    (onChange) => archiveStore.subscribe(onChange),
    () => archiveStore.getState(),
    () => archiveStore.getState(),
  );
  const [now, setNow] = useState(() => Date.now());
  const [form, setForm] = useState<FormState>(() => emptyForm());
  const [filter, setFilter] = useState<"all" | QueueStatus>("all");
  const [selectedCylinder, setSelectedCylinder] = useState("TANK-204");
  const [notice, setNotice] = useState<Notice>(null);
  const [editing, setEditing] = useState<{ reviewId: string; mode: EditMode; form: FormState } | null>(null);
  const [leakDrafts, setLeakDrafts] = useState<Record<string, string>>({});
  const [reviewerDrafts, setReviewerDrafts] = useState<Record<string, string>>({});

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const queue = useMemo(() => buildQueue(state, now), [state, now]);

  const visibleQueue = filter === "all" ? queue : queue.filter((item) => item.status === filter);
  const selected = state.cylinders[selectedCylinder]
    ? selectedCylinder
    : queue[0]?.cylinder.cylinderId ?? "";
  const history = selected ? getCylinderHistory(state, selected) : [];
  const metrics = {
    ready: queue.filter((item) => item.status === "ready").length,
    quarantine: queue.filter((item) => item.status === "quarantine").length,
    resting: queue.filter((item) => item.status === "resting").length,
    released: queue.filter((item) => item.status === "released").length,
  };

  function updateForm(field: keyof FormState, value: string) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  function applyMethod(method: FillMethod) {
    setForm((current) => {
      const next = { ...current, method };
      if (method === "空气充填") return { ...next, oxygenPercent: "21", heliumPercent: "0" };
      if (method === "高氧充填") return { ...next, oxygenPercent: "32", heliumPercent: "0" };
      return { ...next, oxygenPercent: "18", heliumPercent: "35" };
    });
  }

  function handleRegister(event: FormEvent) {
    event.preventDefault();
    const values = valuesFromForm(form);
    const result = archiveStore.register(values);
    if (!result.ok) {
      setNotice({ type: "error", text: result.error });
      return;
    }
    setSelectedCylinder(values.cylinderId);
    if (result.data.reused) {
      setNotice({
        type: "warn",
        text: "该瓶已有一张未结束装配复核单，已沿用首次登记；并发重复登记不会生成第二张单。",
      });
    } else {
      setForm(emptyForm());
      setNotice({
        type: result.data.accepted ? "ok" : "warn",
        text: result.data.accepted
          ? "装配复核通过，气瓶已进入待充填队列。"
          : "复核单已登记，但扭矩/O 型圈批次/检验条件未通过，仅进入待检。",
      });
    }
  }

  function handleStartFill(reviewId: string) {
    const result = archiveStore.completeFill(reviewId);
    if (!result.ok) {
      setNotice({ type: "error", text: result.error });
    } else {
      setNotice({ type: "ok", text: "充填完成，已开始五分钟静置；刷新页面后倒计时仍按真实完成时间继续。" });
    }
  }

  function handleLeak(reviewId: string) {
    const value = parseNumber(leakDrafts[reviewId]);
    if (value === null) {
      setNotice({ type: "error", text: "请输入静置五分钟后的压降（bar）。" });
      return;
    }
    const result = archiveStore.recordLeak(reviewId, value);
    if (!result.ok) {
      setNotice({ type: "error", text: result.error });
    } else {
      setLeakDrafts((current) => ({ ...current, [reviewId]: "" }));
      setNotice({
        type: result.data.accepted ? "ok" : "warn",
        text: result.data.accepted
          ? "泄漏复核合格，等待不同于装配人的复核人签收。"
          : `压降超过 ${MAX_ALLOWED_LEAK_BAR} bar，已扣留；换阀或更正扭矩会生成新复核单并作废旧放行。`,
      });
    }
  }

  function handleRelease(reviewId: string) {
    const reviewer = reviewerDrafts[reviewId] ?? "";
    const result = archiveStore.releaseFill(reviewId, reviewer);
    if (!result.ok) {
      setNotice({ type: "error", text: result.error });
    } else {
      setReviewerDrafts((current) => ({ ...current, [reviewId]: "" }));
      setNotice({ type: "ok", text: "已签收放行；本瓶装配复核单结束。" });
    }
  }

  function startEdit(reviewId: string, mode: EditMode, initial: FormState) {
    setEditing({ reviewId, mode, form: initial });
  }

  function updateEdit(field: keyof FormState, value: string) {
    setEditing((current) => (current ? { ...current, form: { ...current.form, [field]: value } } : current));
  }

  function submitEdit() {
    if (!editing) return;
    const patch = patchFromForm(editing.form);
    if (editing.mode === "edit") {
      const result = archiveStore.correctOpenAssembly(editing.reviewId, patch);
      if (!result.ok) {
        setNotice({ type: "error", text: result.error });
        return;
      }
      setNotice({
        type: result.data.accepted ? "ok" : "warn",
        text: result.data.accepted ? "未结束复核单已更正，可进入充填。" : "更正后仍有待检项，继续停留待检。",
      });
    } else {
      const reason: RevisionReason = editing.mode === "valve" ? "valve-replacement" : "torque-correction";
      const result = archiveStore.replaceOrCorrectAssembly(editing.reviewId, reason, patch);
      if (!result.ok) {
        setNotice({ type: "error", text: result.error });
        return;
      }
      setSelectedCylinder(editing.form.cylinderId);
      setNotice({
        type: result.data.invalidatedReleaseId ? "warn" : result.data.accepted ? "ok" : "warn",
        text: result.data.invalidatedReleaseId
          ? `已生成新的接替复核单，原放行单 ${result.data.invalidatedReleaseId} 已失效。`
          : result.data.accepted
            ? "返修复核单已生成，可重新充填。"
            : "返修复核单已登记，但仍有待检项。",
      });
    }
    setEditing(null);
  }

  const formValues = valuesFromForm(form);
  const formWarnings = getReviewBlockingReasons(formValues, now);
  const inspectionWarning = inspectionAdvice(form.inspectionDue, now);

  return (
    <main className="app">
      <section className="hero">
        <p>hxyfront-62010 · 阀颈扭矩复核 / 充填后泄漏放行台</p>
        <h1>潜水气瓶充填放行台</h1>
        <span>
          每瓶仅允许一张未结束装配复核单；扭矩必须在 {TORQUE_MIN_NM}–{TORQUE_MAX_NM} N·m，O 型圈批次不得过期。
          充填后按完成时刻静置五分钟，泄漏压降 &gt; {MAX_ALLOWED_LEAK_BAR} bar 或复核人与装配人相同均禁止签收。
          存档持久化到本机并在多个标签页之间同步。
        </span>
      </section>

      <section className="metrics">
        <article><small>待充填</small><strong>{metrics.ready}</strong></article>
        <article><small>待检 / 扣留</small><strong>{metrics.quarantine + queue.filter((q) => q.status === "leak-hold").length}</strong></article>
        <article><small>静置中</small><strong>{metrics.resting}</strong><span>5 分钟实时计时</span></article>
        <article><small>有效放行</small><strong>{metrics.released}</strong><span>换阀/更正即失效</span></article>
      </section>

      {notice && <div className={`notice ${notice.type}`}>{notice.text}</div>}

      <section className="workspace">
        <form className="panel register-panel" onSubmit={handleRegister}>
          <div className="heading">
            <div>
              <p>Assembly Review</p>
              <h2>登记装配复核单</h2>
            </div>
            <button className="primary" type="submit">登记 / 沿用首次</button>
          </div>

          <div className="field-grid">
            <label><span>气瓶编号 *</span><input value={form.cylinderId} onChange={(e) => updateForm("cylinderId", e.target.value)} placeholder="TANK-204" /></label>
            <label><span>容积 L *</span><input type="number" step="0.1" value={form.volumeL} onChange={(e) => updateForm("volumeL", e.target.value)} /></label>
            <label><span>检验有效期 *</span><input type="date" value={form.inspectionDue} onChange={(e) => updateForm("inspectionDue", e.target.value)} /></label>
            <label><span>残压 bar</span><input type="number" value={form.residualPressureBar} onChange={(e) => updateForm("residualPressureBar", e.target.value)} /></label>
            <label><span>目标压力 bar</span><input type="number" value={form.targetPressureBar} onChange={(e) => updateForm("targetPressureBar", e.target.value)} /></label>
            <label><span>充填操作员</span><input value={form.operator} onChange={(e) => updateForm("operator", e.target.value)} placeholder="充填人姓名" /></label>
            <label><span>氧含量 %</span><input type="number" step="0.1" value={form.oxygenPercent} onChange={(e) => updateForm("oxygenPercent", e.target.value)} /></label>
            <label><span>氦含量 %</span><input type="number" step="0.1" value={form.heliumPercent} onChange={(e) => updateForm("heliumPercent", e.target.value)} /></label>
          </div>

          <div className="method-row">
            {FILL_METHODS.map((method) => (
              <button type="button" key={method} className={form.method === method ? "selected" : ""} onClick={() => applyMethod(method)}>{method}</button>
            ))}
          </div>
          <p className="mix-hint">{gasMixSummary(formValues)}</p>
          {inspectionWarning && <p className="warning-line">{inspectionWarning}</p>}

          <div className="section-title">
            <h3>阀颈装配复核</h3>
            <span>35–45 N·m 才可放行充填</span>
          </div>
          <div className="field-grid">
            <label><span>阀体号 *</span><input value={form.valveBodyNo} onChange={(e) => updateForm("valveBodyNo", e.target.value)} placeholder="V-77A204" /></label>
            <label><span>O 型圈批次 *</span><input value={form.oRingBatch} onChange={(e) => updateForm("oRingBatch", e.target.value)} placeholder="OR-2609" /></label>
            <label><span>O 型圈批次有效期 *</span><input type="date" value={form.oRingExpiry} onChange={(e) => updateForm("oRingExpiry", e.target.value)} /></label>
            <label><span>阀颈扭矩 N·m *</span><input type="number" step="0.1" value={form.torqueNm} onChange={(e) => updateForm("torqueNm", e.target.value)} placeholder="40" /></label>
            <label className="wide"><span>装配人 *</span><input value={form.assembler} onChange={(e) => updateForm("assembler", e.target.value)} placeholder="实际安装阀颈人员" /></label>
          </div>

          {formWarnings.length > 0 && (
            <div className="rule-box warn">
              <b>登记后只进待检：</b>
              <ul>{formWarnings.slice(0, 6).map((reason) => <li key={reason}>{reason}</li>)}</ul>
            </div>
          )}
          <p className="persist-note">登记即写入 localStorage；另一标签页并发提交相同气瓶时会复用第一张未结束单。</p>
        </form>

        <section className="panel queue-panel">
          <div className="heading">
            <div>
              <p>Release Queue</p>
              <h2>充填与泄漏放行队列</h2>
            </div>
            <button type="button" onClick={() => archiveStore.resetDemo()}>重置演示数据</button>
          </div>
          <div className="chips filter-row">
            <button type="button" className={filter === "all" ? "selected" : ""} onClick={() => setFilter("all")}>全部 {queue.length}</button>
            {(Object.keys(STATUS_LABELS) as QueueStatus[]).map((status) => {
              const count = queue.filter((item) => item.status === status).length;
              if (count === 0 && status !== "quarantine" && status !== "release") return null;
              return <button type="button" key={status} className={filter === status ? "selected" : ""} onClick={() => setFilter(status)}>{STATUS_LABELS[status]} {count}</button>;
            })}
          </div>

          <div className="queue-list">
            {visibleQueue.map((item) => (
              <QueueCard
                key={item.review.id}
                item={item}
                now={now}
                state={state}
                selected={selected === item.cylinder.cylinderId}
                editing={editing?.reviewId === item.review.id ? editing : null}
                leakDraft={leakDrafts[item.review.id] ?? ""}
                reviewerDraft={reviewerDrafts[item.review.id] ?? ""}
                onSelect={() => setSelectedCylinder(item.cylinder.cylinderId)}
                onStartFill={() => handleStartFill(item.review.id)}
                onLeakChange={(value) => setLeakDrafts((current) => ({ ...current, [item.review.id]: value }))}
                onLeak={() => handleLeak(item.review.id)}
                onReviewerChange={(value) => setReviewerDrafts((current) => ({ ...current, [item.review.id]: value }))}
                onRelease={() => handleRelease(item.review.id)}
                onStartEdit={(mode) => startEdit(item.review.id, mode, formFromReview(item.review))}
                onEditChange={updateEdit}
                onSubmitEdit={submitEdit}
                onCancelEdit={() => setEditing(null)}
              />
            ))}
            {visibleQueue.length === 0 && <div className="empty">当前筛选下没有气瓶。</div>}
          </div>
        </section>
      </section>

      <section className="panel history-panel">
        <div className="heading">
          <div>
            <p>Single Cylinder History</p>
            <h2>单瓶履历</h2>
          </div>
          <select value={selected} onChange={(event) => setSelectedCylinder(event.target.value)}>
            {Object.values(state.cylinders).map((cylinder) => <option key={cylinder.cylinderId} value={cylinder.cylinderId}>{cylinder.cylinderId}</option>)}
          </select>
        </div>
        {history.length === 0 ? (
          <p className="empty">暂无履历。</p>
        ) : (
          <ol className="timeline">
            {history.map((eventItem) => (
              <li key={eventItem.id} className={eventItem.kind}>
                <time>{formatDateTime(eventItem.at)}</time>
                <div>
                  <b>{AUDIT_LABELS[eventItem.kind]}</b>
                  <p>{eventItem.summary}</p>
                  {eventItem.detail && <small>{eventItem.detail}</small>}
                </div>
              </li>
            ))}
          </ol>
        )}
      </section>
    </main>
  );
}

interface QueueCardProps {
  item: import("./rules").QueueItem;
  now: number;
  state: ReturnType<typeof archiveStore.getState>;
  selected: boolean;
  editing: { reviewId: string; mode: EditMode; form: FormState } | null;
  leakDraft: string;
  reviewerDraft: string;
  onSelect: () => void;
  onStartFill: () => void;
  onLeakChange: (value: string) => void;
  onLeak: () => void;
  onReviewerChange: (value: string) => void;
  onRelease: () => void;
  onStartEdit: (mode: EditMode) => void;
  onEditChange: (field: keyof FormState, value: string) => void;
  onSubmitEdit: () => void;
  onCancelEdit: () => void;
}

function QueueCard(props: QueueCardProps) {
  const { item, now, editing, leakDraft, reviewerDraft, state } = props;
  const { review, fill, release, status, reasons } = item;
  const inspection = inspectionAdvice(review.inspectionDue, now);
  const releaseBlockers = fill ? getReleaseBlockers(review, fill, reviewerDraft, now) : [];
  const sameAssembler = reviewerDraft.trim() !== "" && isSamePerson(reviewerDraft, review.assembler);

  return (
    <article className={`queue-card ${status} ${props.selected ? "selected" : ""}`} onClick={props.onSelect}>
      <header>
        <div>
          <p>第 {review.sequence} 张复核单 · {review.id}</p>
          <h3>{review.cylinderId} <span>{review.volumeL ?? "-"} L</span></h3>
        </div>
        <span className={`badge ${status}`}>{STATUS_LABELS[status]}</span>
      </header>

      <div className="card-grid">
        <div>
          <small>阀体 / O 型圈</small>
          <strong>{review.valveBodyNo || "未登记"}</strong>
          <p>{review.oRingBatch || "未登记批次"} · 有效期 {review.oRingExpiry || "—"}</p>
        </div>
        <div>
          <small>扭矩 / 装配人</small>
          <strong className={review.torqueNm !== null && review.torqueNm >= TORQUE_MIN_NM && review.torqueNm <= TORQUE_MAX_NM ? "good" : "bad"}>
            {review.torqueNm === null ? "未登记" : `${review.torqueNm} N·m`}
          </strong>
          <p>{review.assembler || "未登记"}</p>
        </div>
        <div>
          <small>充填计划</small>
          <strong>{review.residualPressureBar ?? "-"} → {review.targetPressureBar ?? "-"} bar</strong>
          <p>{review.method} · {review.operator || "未登记操作员"}</p>
        </div>
        <div>
          <small>检验</small>
          <strong className={inspection?.includes("过期") || inspection?.includes("今天") ? "bad" : inspection ? "warn-text" : "good"}>
            {review.inspectionDue || "未登记"}
          </strong>
          <p>{inspection ?? "检验有效期正常"}</p>
        </div>
      </div>

      <p className="mix-line">{gasMixSummary(review)}</p>

      {reasons.length > 0 && (
        <ul className="reason-list">
          {reasons.map((reason) => <li key={reason}>{reason}</li>)}
        </ul>
      )}

      {fill && (
        <div className="fill-strip">
          <span>充填完成：{formatDateTime(fill.filledAt)}</span>
          {fill.leakLossBar !== null && <span>压降：{fill.leakLossBar} bar {fill.leakLossBar > MAX_ALLOWED_LEAK_BAR ? "（超限）" : "（合格）"}</span>}
          {release && <span>放行：{release.status === "valid" ? `${release.reviewer} 已签收` : `已失效（${release.invalidReason === "valve-replacement" ? "换阀" : "更正扭矩"}）`}</span>}
        </div>
      )}

      <div className="actions" onClick={(event) => event.stopPropagation()}>
        {status === "ready" && <button className="primary" onClick={props.onStartFill}>完成充填并开始静置 5 分钟</button>}
        {status === "quarantine" && <button onClick={() => props.onStartEdit("edit")}>更正当前未结束复核单</button>}
        {status === "resting" && <div className="timer">静置中 {formatRemaining(item.restRemainingMs)}</div>}
        {(status === "release" || status === "leak-hold") && (
          <div className="release-workflow">
            {item.restRemainingMs <= 0 && (
              <div className="inline-form">
                <input aria-label="泄漏压降" type="number" step="0.1" placeholder="五分钟压降 bar" value={leakDraft} onChange={(e: ChangeEvent<HTMLInputElement>) => props.onLeakChange(e.target.value)} />
                <button onClick={props.onLeak}>登记泄漏复核</button>
              </div>
            )}
            {fill && fill.leakLossBar !== null && fill.leakLossBar <= MAX_ALLOWED_LEAK_BAR && (
              <div className="inline-form">
                <input aria-label="放行复核人" placeholder="放行复核人（不得同装配人）" value={reviewerDraft} onChange={(e) => props.onReviewerChange(e.target.value)} className={sameAssembler ? "invalid-input" : ""} />
                <button className="primary" onClick={props.onRelease} disabled={getReleaseBlockers(review, fill, reviewerDraft, now).length > 0}>签收放行</button>
              </div>
            )}
            {releaseBlockers.length > 0 && <ul className="reason-list compact">{releaseBlockers.map((reason) => <li key={reason}>{reason}</li>)}</ul>}
            {status === "leak-hold" && (
              <>
                <button onClick={() => props.onStartEdit("valve")}>更换阀体重新装配</button>
                <button onClick={() => props.onStartEdit("torque")}>更正阀颈扭矩</button>
              </>
            )}
          </div>
        )}
        {status === "released" && (
          <div className="revision-row">
            <button onClick={() => props.onStartEdit("valve")}>换阀（原放行失效）</button>
            <button onClick={() => props.onStartEdit("torque")}>更正扭矩（原放行失效）</button>
          </div>
        )}
        {status === "invalidated" && <em>放行已失效，新复核单在队列中重新流转；原履历保留。</em>}
      </div>

      {editing && (
        <div className="edit-box" onClick={(event) => event.stopPropagation()}>
          <h4>{editing.mode === "edit" ? "更正当前未结束复核单" : editing.mode === "valve" ? "更换阀体并生成接替复核单" : "更正扭矩并生成接替复核单"}</h4>
          <div className="edit-grid">
            <label><span>新阀体号</span><input value={editing.form.valveBodyNo} onChange={(e) => props.onEditChange("valveBodyNo", e.target.value)} disabled={editing.mode === "torque"} /></label>
            <label><span>O 型圈批次</span><input value={editing.form.oRingBatch} onChange={(e) => props.onEditChange("oRingBatch", e.target.value)} /></label>
            <label><span>批次有效期</span><input type="date" value={editing.form.oRingExpiry} onChange={(e) => props.onEditChange("oRingExpiry", e.target.value)} /></label>
            <label><span>扭矩 N·m</span><input type="number" step="0.1" value={editing.form.torqueNm} onChange={(e) => props.onEditChange("torqueNm", e.target.value)} /></label>
            <label><span>装配人</span><input value={editing.form.assembler} onChange={(e) => props.onEditChange("assembler", e.target.value)} /></label>
          </div>
          <div className="revision-row">
            <button className="primary" onClick={props.onSubmitEdit}>提交并写入履历</button>
            <button onClick={props.onCancelEdit}>取消</button>
          </div>
        </div>
      )}

      {state.reviews.filter((r) => r.cylinderId === review.cylinderId).length > 1 && (
        <p className="sequence-note">该瓶历史复核单：{state.reviews.filter((r) => r.cylinderId === review.cylinderId).map((r) => `#${r.sequence}`).join("、")}；仅最新一张可流转。</p>
      )}
    </article>
  );
}

export default App;
