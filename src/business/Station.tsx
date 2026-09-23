// 界面层：阀颈扭矩复核与充填后泄漏放行台。
// 读：useSyncExternalStore 订阅存档（刷新 / 多标签页写入后自动一致）；
// 写：全部动作走 archive，判定全部走 rules。

import { ReactNode, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { archive, TankOrder, TimelineEvent } from "./archive";
import {
  AssemblyDraft,
  FillMethod,
  LEAK_LIMIT_BAR,
  OrderDraft,
  REST_MILLIS,
  TORQUE_MAX_NM,
  TORQUE_MIN_NM,
  assemblyVerdict,
  batchUsable,
  evaluateRelease,
  findBatch,
  formatDateTime,
  formatRemain,
  gasKindOf,
  inspectStateOf,
  nitrogenPct,
  oRingBatches,
  restRemaining,
  validateAssembly,
  validateOrder,
} from "./rules";

// ───────────────────────── 通用小组件 ─────────────────────────

const STAGE_LABEL: Record<TankOrder["stage"], string> = {
  queued: "待装配复核",
  "await-check": "待检",
  ready: "可充填",
  filling: "静置检漏中",
  released: "已放行",
};

function Badge({ tone, children }: { tone: "blue" | "amber" | "red" | "green" | "gray"; children: ReactNode }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

function NumInput(props: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  step?: string;
  invalid?: boolean;
}) {
  return (
    <input
      type="number"
      inputMode="decimal"
      step={props.step ?? "any"}
      value={props.value}
      placeholder={props.placeholder}
      onChange={(e) => props.onChange(e.target.value)}
      className={props.invalid ? "invalid" : undefined}
    />
  );
}

function nowTick(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return now;
}

const num = (s: string): number | null => (s.trim() === "" ? null : Number(s));

// ───────────────────────── 入队登记表单 ─────────────────────────

interface EnqueueForm {
  tankNo: string;
  volumeL: string;
  inspectUntil: string;
  residualBar: string;
  targetBar: string;
  o2Pct: string;
  hePct: string;
  method: FillMethod;
  operator: string;
}

const EMPTY_FORM: EnqueueForm = {
  tankNo: "",
  volumeL: "12",
  inspectUntil: "",
  residualBar: "0",
  targetBar: "200",
  o2Pct: "21",
  hePct: "0",
  method: "空压机",
  operator: "",
};

function EnqueuePanel({ onError }: { onError: (msg: string | null) => void }) {
  const [f, setF] = useState<EnqueueForm>(EMPTY_FORM);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const set = (k: keyof EnqueueForm) => (v: string) => setF((p) => ({ ...p, [k]: v }));

  const o2 = num(f.o2Pct) ?? 0;
  const he = num(f.hePct) ?? 0;
  const gas = gasKindOf(o2, he);
  const n2 = nitrogenPct(o2, he);
  const inspect = f.inspectUntil ? inspectStateOf(f.inspectUntil, Date.now()) : null;

  function submit() {
    const draft: OrderDraft = {
      tankNo: f.tankNo,
      volumeL: num(f.volumeL),
      inspectUntil: f.inspectUntil,
      residualBar: num(f.residualBar),
      targetBar: num(f.targetBar),
      o2Pct: num(f.o2Pct),
      hePct: num(f.hePct),
      method: f.method,
      operator: f.operator,
    };
    const errs = validateOrder(draft);
    setErrors(errs);
    if (Object.keys(errs).length > 0) return;
    const res = archive.addOrder(draft, Date.now());
    if (!res.ok) {
      onError(res.error);
      return;
    }
    onError(null);
    setF({ ...EMPTY_FORM, inspectUntil: "" });
  }

  return (
    <section className="panel">
      <div className="heading">
        <div>
          <p>第一步 · 入队登记</p>
          <h2>气瓶充填登记</h2>
        </div>
        <Badge tone="blue">同瓶仅允许一条未结束单据</Badge>
      </div>

      <div className="field-grid">
        <label>
          <span>气瓶编号 *</span>
          <input value={f.tankNo} onChange={(e) => set("tankNo")(e.target.value)} placeholder="如 TANK-301" className={errors.tankNo ? "invalid" : undefined} />
          {errors.tankNo && <em className="err">{errors.tankNo}</em>}
        </label>
        <label>
          <span>容积（L）*</span>
          <NumInput value={f.volumeL} onChange={set("volumeL")} invalid={!!errors.volumeL} />
          {errors.volumeL && <em className="err">{errors.volumeL}</em>}
        </label>
        <label>
          <span>检验有效期 *</span>
          <input type="date" value={f.inspectUntil} onChange={(e) => set("inspectUntil")(e.target.value)} className={errors.inspectUntil ? "invalid" : undefined} />
          {errors.inspectUntil ? (
            <em className="err">{errors.inspectUntil}</em>
          ) : inspect === "expired" ? (
            <em className="err">检验已过期，不得充填</em>
          ) : inspect === "warn" ? (
            <em className="warn-text">30 天内到期，留意提醒</em>
          ) : null}
        </label>
        <label>
          <span>操作员 *</span>
          <input value={f.operator} onChange={(e) => set("operator")(e.target.value)} placeholder="充填操作员" className={errors.operator ? "invalid" : undefined} />
          {errors.operator && <em className="err">{errors.operator}</em>}
        </label>
        <label>
          <span>残压（bar）</span>
          <NumInput value={f.residualBar} onChange={set("residualBar")} invalid={!!errors.residualBar} />
          {errors.residualBar && <em className="err">{errors.residualBar}</em>}
        </label>
        <label>
          <span>目标压力（bar）*</span>
          <NumInput value={f.targetBar} onChange={set("targetBar")} invalid={!!errors.targetBar} />
          {errors.targetBar && <em className="err">{errors.targetBar}</em>}
        </label>
        <label>
          <span>氧含量 O₂（%）</span>
          <NumInput value={f.o2Pct} onChange={set("o2Pct")} invalid={!!errors.o2Pct} />
          {errors.o2Pct && <em className="err">{errors.o2Pct}</em>}
        </label>
        <label>
          <span>氦含量 He（%）</span>
          <NumInput value={f.hePct} onChange={set("hePct")} invalid={!!errors.hePct} />
          {errors.hePct && <em className="err">{errors.hePct}</em>}
        </label>
        <label>
          <span>充填方式</span>
          <select value={f.method} onChange={(e) => set("method")(e.target.value)}>
            {(["空压机", "增压机", "分压混配"] as FillMethod[]).map((m) => (
              <option key={m}>{m}</option>
            ))}
          </select>
        </label>
        <div className="mix-hint">
          <div className="mix-bar">
            <span style={{ background: "#0d9488", width: `${o2}%` }} title={`O₂ ${o2}%`} />
            <span style={{ background: "#075985", width: `${he}%` }} title={`He ${he}%`} />
            <span style={{ background: "#cbd5e1", width: `${n2}%` }} title={`N₂ ${n2}%`} />
          </div>
          <p>
            <b className="gas-tag">{gas}</b>
            O₂ {o2}% · He {he}% · N₂ {n2}%
            {o2 + he > 100 && <em className="err">　比例合计超过 100%</em>}
          </p>
        </div>
      </div>

      <div className="form-actions">
        <button className="primary" onClick={submit}>
          排入待充填队列
        </button>
      </div>
    </section>
  );
}

// ───────────────────────── 装配复核单（每瓶唯一未结单） ─────────────────────────

function AssemblySheet({ order, now, embedded }: { order: TankOrder; now: number; embedded?: boolean }) {
  const [valveNo, setValveNo] = useState(order.assembly?.valveNo ?? "");
  const [batch, setBatch] = useState(order.assembly?.oRingBatch ?? "");
  const [torque, setTorque] = useState(order.assembly ? String(order.assembly.torqueNm) : "");
  const [assembler, setAssembler] = useState(order.assembly?.assembler ?? "");
  const [feedback, setFeedback] = useState<{ passed: boolean; reasons: string[] } | null>(null);

  const isRevise = order.assembly !== null;
  const batches = oRingBatches(now);
  const draft: AssemblyDraft = {
    valveNo,
    oRingBatch: batch,
    torqueNm: num(torque),
    assembler,
  };
  const fieldErrs = validateAssembly(draft);
  const live = torque.trim() !== "" && batch.trim() !== "" && valveNo.trim() !== "" && assembler.trim() !== ""
    ? assemblyVerdict(draft, now)
    : null;
  const batchInfo = batch ? findBatch(batch, now) : undefined;

  function submit() {
    if (Object.keys(fieldErrs).length > 0) return;
    const r = archive.submitAssembly(order.id, draft, Date.now());
    setFeedback(r);
  }

  return (
    <div className={`sheet ${embedded ? "sheet-embedded" : ""}`}>
      <div className="sheet-head">
        <div>
          <p>{isRevise ? "装配更正（换阀 / 更正扭矩）" : "第二步 · 阀颈扭矩复核"}</p>
          <h4>
            装配复核单{" "}
            {order.reviewSheetId ? (
              <span className="mono">{order.reviewSheetId}</span>
            ) : (
              <span className="muted">（上一单已结束，打开后另领新单）</span>
            )}
          </h4>
        </div>
        <div>
          {order.reviewSheetId ? (
            <Badge tone="amber">未结束 · 重复/并发打开沿用本单</Badge>
          ) : (
            <button className="mini" onClick={() => archive.openReviewSheet(order.id, Date.now())}>
              打开装配复核单
            </button>
          )}
        </div>
      </div>

      {order.reviewSheetId && (
        <>
          <div className="field-grid three">
            <label>
              <span>阀体号 *</span>
              <input value={valveNo} onChange={(e) => setValveNo(e.target.value)} placeholder="如 V-7810" className={fieldErrs.valveNo ? "invalid" : undefined} />
            </label>
            <label>
              <span>O 型圈批次 *</span>
              <select value={batch} onChange={(e) => setBatch(e.target.value)} className={fieldErrs.oRingBatch ? "invalid" : undefined}>
                <option value="">选择批次</option>
                {batches.map((b) => {
                  const expired = !batchUsable(b.code, now);
                  return (
                    <option key={b.code} value={b.code}>
                      {b.code} · {b.vendor} · {expired ? `已过期 ${b.expiresOn}` : `有效期至 ${b.expiresOn}`}
                    </option>
                  );
                })}
              </select>
            </label>
            <label>
              <span>扭矩（N·m，允许 {TORQUE_MIN_NM}~{TORQUE_MAX_NM}）*</span>
              <NumInput value={torque} onChange={setTorque} placeholder="如 40" invalid={!!(live && !live.torqueOk)} />
            </label>
            <label>
              <span>装配人 *</span>
              <input value={assembler} onChange={(e) => setAssembler(e.target.value)} placeholder="执行装配的人员" className={fieldErrs.assembler ? "invalid" : undefined} />
            </label>
          </div>

          <div className="live-checks">
            {live ? (
              live.pass ? (
                <Badge tone="green">实时判定：扭矩合规、批次有效 → 复核通过可充填</Badge>
              ) : (
                live.reasons.map((r) => (
                  <Badge key={r} tone="red">
                    {r} → 只进待检
                  </Badge>
                ))
              )
            ) : (
              <span className="muted">填写完整后实时判定；批次信息：{batchInfo ? `${batchInfo.vendor}，有效期至 ${batchInfo.expiresOn}` : "未选择"}</span>
            )}
          </div>

          {embedded && isRevise && order.filledAt !== null && (
            <p className="warn-box">
              该瓶已完成充填{order.release ? "并已签收" : ""}：换阀或更正扭矩将作废本次静置
              {order.release ? "，且原放行立即失效、须重新走静置与签收" : ""}。
            </p>
          )}

          <div className="form-actions">
            <button className="primary" onClick={submit} disabled={Object.keys(fieldErrs).length > 0}>
              {isRevise ? "提交更正并重新判定" : "提交复核登记"}
            </button>
          </div>

          {feedback && (
            <div className={`alert ${feedback.passed ? "alert-ok" : "alert-warn"}`}>
              {feedback.passed ? (
                <>复核通过，气瓶转入「可充填」。</>
              ) : (
                <>
                  复核未通过，气瓶只进「待检」：
                  {feedback.reasons.map((r) => (
                    <li key={r}>{r}</li>
                  ))}
                  更正后重新提交即可，仍沿用同一张复核单。
                </>
              )}
            </div>
          )}

          {order.attempts.length > 0 && (
            <details className="attempts">
              <summary>本单登记/更正留痕（{order.attempts.length} 次）</summary>
              <ol>
                {order.attempts.map((a) => (
                  <li key={a.seq} className={a.passed ? "ok-text" : "err"}>
                    第 {a.seq} 次 · {a.kind === "revise" ? "更正" : "首次登记"} · 阀体 {a.valveNo} · O 圈 {a.oRingBatch} · 扭矩{" "}
                    {a.torqueNm} N·m · 装配人 {a.assembler} · {formatDateTime(a.at)}
                    {!a.passed && ` → ${a.reasons.join("；")}`}
                  </li>
                ))}
              </ol>
            </details>
          )}
        </>
      )}
    </div>
  );
}

// ───────────────────────── 充填静置与泄漏放行 ─────────────────────────

function ReleasePanel({ order, now }: { order: TankOrder; now: number }) {
  const [currentBar, setCurrentBar] = useState("");
  const [reviewer, setReviewer] = useState("");
  const [errors, setErrors] = useState<string[] | null>(null);

  const remain = restRemaining(order.filledAt, now);
  const elapsed = order.filledAt ? Math.min(REST_MILLIS, now - order.filledAt) : 0;
  const cur = num(currentBar);

  const check = evaluateRelease(
    {
      filledAt: order.filledAt,
      now,
      torqueNm: order.assembly!.torqueNm,
      oRingBatch: order.assembly!.oRingBatch,
      currentBar: cur,
      targetBar: order.targetBar,
      reviewer,
      assembler: order.assembly!.assembler,
    },
  );

  if (order.stage === "ready") {
    return (
      <div className="release-zone">
        <p className="muted">复核已通过，可执行充填。</p>
        <button className="primary" onClick={() => archive.markFilled(order.id, Date.now())}>
          完成充填至 {order.targetBar} bar，开始 5 分钟静置
        </button>
      </div>
    );
  }

  if (order.stage !== "filling") return null;

  return (
    <div className="release-zone">
      <p>
        充填时间：{formatDateTime(order.filledAt as number)} · 静置满 5 分钟后方可检漏签收（泄漏 &gt; {LEAK_LIMIT_BAR} bar 或复核人与装配人相同均不得签收）
      </p>
      <div className="rest-track">
        <div style={{ width: `${(elapsed / REST_MILLIS) * 100}%` }} />
      </div>
      {remain > 0 ? (
        <p>
          <Badge tone="amber">静置中，剩余 {formatRemain(remain)}</Badge>
        </p>
      ) : (
        <>
          <Badge tone="green">静置已满 5 分钟，录入检漏数据</Badge>
          <div className="field-grid three">
            <label>
              <span>静置后实测压力（bar）</span>
              <NumInput value={currentBar} onChange={setCurrentBar} placeholder={`目标 ${order.targetBar}`} />
            </label>
            <label>
              <span>泄漏复核人（不可与装配人「{order.assembly!.assembler}」相同）</span>
              <input value={reviewer} onChange={(e) => setReviewer(e.target.value)} placeholder="换人复核" />
            </label>
            <div className="drop-preview">
              <span>压降</span>
              <strong className={cur !== null && order.targetBar - cur > LEAK_LIMIT_BAR ? "err" : "ok-text"}>
                {cur === null ? "—" : `${(order.targetBar - cur).toFixed(1)} bar`}
              </strong>
            </div>
          </div>
          <ul className="rule-list">
            {check.reasons.length === 0 ? (
              <li className="ok-text">全部放行条件满足，可签收。</li>
            ) : (
              check.reasons.map((r) => (
                <li key={r} className="err">
                  {r}
                </li>
              ))
            )}
          </ul>
          <button
            className="primary"
            disabled={!check.canSign}
            onClick={() => {
              const r = archive.signRelease(order.id, { reviewer, currentBar: cur }, Date.now());
              if (!r.ok) setErrors(r.reasons);
              else {
                setErrors(null);
                setCurrentBar("");
                setReviewer("");
              }
            }}
          >
            放行签收
          </button>
          {errors && (
            <div className="alert alert-warn">
              {errors.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ───────────────────────── 队列卡片 ─────────────────────────

function OrderCard({ order, now, onShowHistory }: { order: TankOrder; now: number; onShowHistory: (tank: string) => void }) {
  const [showAssembly, setShowAssembly] = useState(false);
  const inspect = inspectStateOf(order.inspectUntil, now);

  const tone =
    order.stage === "released"
      ? "green"
      : order.stage === "await-check"
        ? "red"
        : order.stage === "filling"
          ? "amber"
          : "blue";

  // 未放行：未复核时复核单直接展开；已复核的瓶默认折叠，供换阀/更正扭矩再打开
  const assemblyOpen = order.stage !== "released" && (order.assembly === null || showAssembly);

  return (
    <article className="queue-card">
      <header className="queue-head">
        <div>
          <h3>
            {order.tankNo}
            <Badge tone={tone}>{STAGE_LABEL[order.stage]}</Badge>
            <Badge tone="gray">{order.gasKind}</Badge>
            {inspect === "expired" && <Badge tone="red">检验过期</Badge>}
            {inspect === "warn" && <Badge tone="amber">检验临近</Badge>}
            {order.releaseVoided && <Badge tone="red">原放行已失效</Badge>}
          </h3>
          <p className="muted">
            {order.volumeL}L · {order.method} · O₂ {order.o2Pct}% / He {order.hePct}% · 残压 {order.residualBar} → 目标 {order.targetBar} bar
            · 检验至 {order.inspectUntil} · 操作员 {order.operator} · 入队 {formatDateTime(order.createdAt)}
          </p>
        </div>
        <button className="mini" onClick={() => onShowHistory(order.tankNo)}>
          单瓶履历
        </button>
      </header>

      {order.releaseVoided && order.release && (
        <div className="alert alert-warn">
          原放行（{formatDateTime(order.release.signedAt)}，复核人 {order.release.reviewer}，压降 {order.release.dropBar.toFixed(1)} bar）已因
          {order.voidReason ?? "装配更正"}失效；须重新复核、充填、静置、签收后方可再次放行。
        </div>
      )}

      {order.stage !== "released" && assemblyOpen && <AssemblySheet order={order} now={now} embedded={order.assembly !== null} />}

      {(order.stage === "ready" || order.stage === "filling") && <ReleasePanel order={order} now={now} />}

      {order.stage !== "released" && order.assembly !== null && !assemblyOpen && (
        <div className="assembly-summary">
          <span>
            当前装配：阀体 {order.assembly.valveNo} · O 圈 {order.assembly.oRingBatch} · 扭矩 {order.assembly.torqueNm} N·m · 装配人{" "}
            {order.assembly.assembler}
          </span>
          <button className="linkish" onClick={() => setShowAssembly(true)}>
            换阀或更正扭矩{order.stage === "filling" ? "（将作废静置" : ""}
            {order.stage === "filling" ? "）" : ""}
          </button>
        </div>
      )}

      {order.stage === "released" && order.release && (
        <div className="released-box">
          <p>
            <Badge tone="green">已放行签收</Badge>
            签收时间 {formatDateTime(order.release.signedAt)} · 复核人 {order.release.reviewer} · 静置后实测 {order.release.currentBar} bar ·
            压降 {order.release.dropBar.toFixed(1)} bar
          </p>
          <p className="muted">
            签收快照：阀体 {order.release.snapshot.valveNo} · O 圈 {order.release.snapshot.oRingBatch} · 扭矩 {order.release.snapshot.torqueNm} N·m ·
            装配人 {order.release.snapshot.assembler}
          </p>
          {!showAssembly ? (
            <button className="mini" onClick={() => setShowAssembly(true)}>
              换阀或更正扭矩（原放行将失效）
            </button>
          ) : (
            <AssemblySheet order={order} now={now} embedded />
          )}
        </div>
      )}
    </article>
  );
}

// ───────────────────────── 单瓶履历 ─────────────────────────

function HistoryPanel({ tank, onClose }: { tank: string | null; onClose: () => void }) {
  const events: TimelineEvent[] = tank ? archive.historyOf(tank) : [];
  if (!tank) return null;
  return (
    <section className="panel history-panel">
      <div className="heading">
        <div>
          <p>单瓶履历</p>
          <h2>{tank}</h2>
        </div>
        <button className="mini" onClick={onClose}>
          关闭
        </button>
      </div>
      {events.length === 0 ? (
        <p className="muted">暂无记录。</p>
      ) : (
        <ol className="timeline">
          {events.map((e) => (
            <li key={e.id} className={`tl tl-${eventTone(e.kind)}`}>
              <time>{formatDateTime(e.time)}</time>
              <Badge tone={eventTone(e.kind)}>{e.kind}</Badge>
              <span>{e.detail}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function eventTone(kind: TimelineEvent["kind"]): "blue" | "amber" | "red" | "green" | "gray" {
  switch (kind) {
    case "复核通过":
    case "放行":
      return "green";
    case "转待检":
    case "放行失效":
      return "red";
    case "充填":
    case "更正装配":
      return "amber";
    case "开单":
      return "blue";
    default:
      return "gray";
  }
}

// ───────────────────────── 主台 ─────────────────────────

type Filter = "all" | TankOrder["stage"] | "active";

export default function Station() {
  const state = useSyncExternalStore(archive.subscribe, archive.getState);
  const now = nowTick();
  const [filter, setFilter] = useState<Filter>("active");
  const [keyword, setKeyword] = useState("");
  const [historyTank, setHistoryTank] = useState<string | null>(null);
  const [enqueueError, setEnqueueError] = useState<string | null>(null);

  const orders = useMemo(() => Object.values(state.orders).sort((a, b) => a.createdAt - b.createdAt), [state.orders]);

  const counts = useMemo(() => {
    const c = { active: 0, queued: 0, "await-check": 0, ready: 0, filling: 0, released: 0 };
    for (const o of orders) {
      if (o.stage !== "released") c.active++;
      c[o.stage]++;
    }
    return c;
  }, [orders]);

  const visible = orders.filter((o) => {
    if (filter === "all") return true;
    if (filter === "active") return o.stage !== "released";
    return o.stage === filter;
  }).filter((o) => (keyword.trim() ? o.tankNo.toLowerCase().includes(keyword.trim().toLowerCase()) : true));

  const batches = oRingBatches(now);

  return (
    <main className="app station">
      <section className="hero">
        <p>hxyfront-62010 · 阀颈扭矩复核与充填后泄漏放行台</p>
        <h1>潜水气瓶充填 · 双关卡放行</h1>
        <span>
          装配关：扭矩须 {TORQUE_MIN_NM}~{TORQUE_MAX_NM} N·m、O 型圈批次在册未过期，否则只进待检；充填关：静置满 5 分钟、泄漏 ≤ {LEAK_LIMIT_BAR}{" "}
          bar、复核人与装配人不得为同一人。换阀或更正扭矩后原放行立即失效。
        </span>
      </section>

      <section className="metrics">
        <article><small>未结束单据</small><strong>{counts.active}</strong></article>
        <article><small>待检（复核未过）</small><strong>{counts["await-check"]}</strong></article>
        <article><small>静置检漏中</small><strong>{counts.filling}</strong></article>
        <article><small>已放行签收</small><strong>{counts.released}</strong></article>
      </section>

      {enqueueError && (
        <div className="alert alert-warn">
          {enqueueError}
          <button className="mini" onClick={() => setEnqueueError(null)}>知道了</button>
        </div>
      )}

      <EnqueuePanel onError={setEnqueueError} />

      <section className="panel batch-panel">
        <div className="heading">
          <div>
            <p>台账</p>
            <h2>O 型圈批次目录</h2>
          </div>
          <button className="mini" onClick={() => { if (confirm("恢复内置演示数据？当前存档将被覆盖。")) archive.resetDemo(); }}>
            重置演示数据
          </button>
        </div>
        <div className="batch-grid">
          {batches.map((b) => {
            const usable = batchUsable(b.code, now);
            return (
              <div key={b.code} className={`batch-item ${usable ? "" : "batch-expired"}`}>
                <strong>{b.code}</strong>
                <span>{b.vendor}</span>
                <span>有效期至 {b.expiresOn}</span>
                <Badge tone={usable ? "green" : "red"}>{usable ? "可用" : "已过期"}</Badge>
              </div>
            );
          })}
        </div>
      </section>

      <section className="panel queue-panel">
        <div className="heading">
          <div>
            <p>第三步 / 第四步</p>
            <h2>充填队列与放行台</h2>
          </div>
          <input className="search" placeholder="搜气瓶编号" value={keyword} onChange={(e) => setKeyword(e.target.value)} />
        </div>
        <div className="chips">
          {([
            ["active", "未结束"],
            ["queued", STAGE_LABEL.queued],
            ["await-check", STAGE_LABEL["await-check"]],
            ["ready", STAGE_LABEL.ready],
            ["filling", STAGE_LABEL.filling],
            ["released", STAGE_LABEL.released],
            ["all", "全部"],
          ] as [Filter, string][]).map(([key, label]) => (
            <button key={key} className={filter === key ? "chip-on" : undefined} onClick={() => setFilter(key)}>
              {label}
            </button>
          ))}
        </div>

        <div className="queue-list">
          {visible.length === 0 && <p className="muted">当前筛选下没有单据。</p>}
          {visible.map((o) => (
            <OrderCard key={o.id} order={o} now={now} onShowHistory={setHistoryTank} />
          ))}
        </div>
      </section>

      <HistoryPanel tank={historyTank} onClose={() => setHistoryTank(null)} />
    </main>
  );
}
