// 业务规则冒烟测试：node 运行（npx esbuild 打包）
import { FillArchive } from "./src/business/archive";
import {
  TORQUE_MIN_NM,
  TORQUE_MAX_NM,
  LEAK_LIMIT_BAR,
  REST_MILLIS,
  assemblyVerdict,
  evaluateRelease,
  batchUsable,
} from "./src/business/rules";

// --- localStorage 桩：模拟刷新后重新加载 ---
const mem = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
};

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, extra = "") {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.error(`  ✗ ${name} ${extra}`);
  }
}

const T0 = Date.parse("2026-09-22T10:00:00+08:00");
const day = 86400000;
const future = new Date(T0 + 200 * day).toISOString().slice(0, 10);

function orderDraft(over: any = {}) {
  return {
    tankNo: "TANK-T1",
    volumeL: 12,
    inspectUntil: future,
    residualBar: 50,
    targetBar: 200,
    o2Pct: 21,
    hePct: 0,
    method: "空压机" as const,
    operator: "操作员甲",
    ...over,
  };
}

console.log("规则常量：");
check(`扭矩区间 ${TORQUE_MIN_NM}~${TORQUE_MAX_NM}`, TORQUE_MIN_NM === 35 && TORQUE_MAX_NM === 45);
check(`静置 ${REST_MILLIS / 60000} 分钟`, REST_MILLIS === 5 * 60000);
check(`泄漏阈值 ${LEAK_LIMIT_BAR} bar`, LEAK_LIMIT_BAR === 3);

console.log("1) 每瓶仅一条未结束单据 / 复核单沿用首次：");
let arc = new FillArchive();
// 清空演示数据，从空台账开始
mem.clear();
arc = new FillArchive();
const r1 = arc.addOrder(orderDraft(), T0);
check("首次入队成功", r1.ok);
const dup = arc.addOrder(orderDraft(), T0 + 1000);
check("同瓶重复入队被拒", !dup.ok && "error" in dup);
const oid = (r1 as any).orderId;

const s1 = arc.openReviewSheet(oid, T0 + 2000);
const s2 = arc.openReviewSheet(oid, T0 + 3000); // 模拟并发/重复打开
check("重复/并发打开沿用首张复核单", s1 === s2);

console.log("2) 扭矩越界或批次过期 → 只进待检：");
const validBatch = "OR-2608-A";
const expiredBatch = "OR-2511-B";
check("有效批次判定", batchUsable(validBatch, T0) === true);
check("过期批次判定", batchUsable(expiredBatch, T0) === false);

let v = assemblyVerdict({ valveNo: "V1", oRingBatch: validBatch, torqueNm: 48, assembler: "装配甲" }, T0);
check("扭矩 48 越界不通过", v.pass === false && v.torqueOk === false);
v = assemblyVerdict({ valveNo: "V1", oRingBatch: validBatch, torqueNm: 35, assembler: "装配甲" }, T0);
check("扭矩 35 边界通过", v.pass === true);
v = assemblyVerdict({ valveNo: "V1", oRingBatch: validBatch, torqueNm: 45, assembler: "装配甲" }, T0);
check("扭矩 45 边界通过", v.pass === true);
v = assemblyVerdict({ valveNo: "V1", oRingBatch: expiredBatch, torqueNm: 40, assembler: "装配甲" }, T0);
check("批次过期不通过", v.pass === false && v.batchOk === false);
v = assemblyVerdict({ valveNo: "V1", oRingBatch: "NOPE", torqueNm: 40, assembler: "装配甲" }, T0);
check("批次不在台账不通过", v.pass === false);

let res = arc.submitAssembly(oid, { valveNo: "V-9001", oRingBatch: validBatch, torqueNm: 30, assembler: "装配甲" }, T0 + 4000);
check("扭矩 30 登记后只进待检", res.passed === false && arc.getState().orders[oid].stage === "await-check");
check("待检状态充填被拒", arc.markFilled(oid, T0 + 5000).ok === false);
res = arc.submitAssembly(oid, { valveNo: "V-9001", oRingBatch: validBatch, torqueNm: 40, assembler: "装配甲" }, T0 + 6000);
check("同单更正为 40 后通过且仍为原单", res.passed === true && arc.getState().orders[oid].reviewSheetId === s1);
check("通过后阶段=可充填", arc.getState().orders[oid].stage === "ready");

console.log("3) 充填后静置 5 分钟 / 泄漏 / 复核人规则：");
check("可充填状态充填成功", arc.markFilled(oid, T0 + 7000).ok);

let rel = arc.signRelease(oid, { reviewer: "复核乙", currentBar: 198 }, T0 + 7000 + 60000); // 1 分钟
check("静置未满 5 分钟不得签收", !rel.ok);
rel = arc.signRelease(oid, { reviewer: "复核乙", currentBar: 198 }, T0 + 7000 + REST_MILLIS + 1000);
check("满 5 分钟 + 压降 2 bar + 换人 → 签收", rel.ok);
const order = arc.getState().orders[oid];
check("签收后复核单关闭", order.reviewSheetId === null && order.stage === "released");

// 第二瓶：泄漏超 3 bar
const r2 = arc.addOrder(orderDraft({ tankNo: "TANK-T2" }), T0 + 10000);
const oid2 = (r2 as any).orderId;
arc.openReviewSheet(oid2, T0 + 11000);
arc.submitAssembly(oid2, { valveNo: "V2", oRingBatch: validBatch, torqueNm: 42, assembler: "装配甲" }, T0 + 12000);
arc.markFilled(oid2, T0 + 13000);
rel = arc.signRelease(oid2, { reviewer: "复核乙", currentBar: 196 }, T0 + 13000 + REST_MILLIS + 1000); // 压降 4
check("泄漏压降 4 bar 不得签收", !rel.ok);
rel = arc.signRelease(oid2, { reviewer: "装配甲", currentBar: 199 }, T0 + 13000 + REST_MILLIS + 1000);
check("复核人与装配人相同不得签收", !rel.ok);
rel = arc.signRelease(oid2, { reviewer: "复核乙", currentBar: 197 }, T0 + 13000 + REST_MILLIS + 1000); // 压降 3，边界
check("泄漏压降恰好 3 bar 可签收", rel.ok);

console.log("4) 换阀/更正扭矩 → 原放行失效，需重做：");
// 已签收的 T1：先打开新复核单（上一张已关闭）
const s3 = arc.openReviewSheet(oid, T0 + 20000);
check("放行失效后重开领到新单号", s3 !== s1);
arc.submitAssembly(oid, { valveNo: "V-9999", oRingBatch: validBatch, torqueNm: 41, assembler: "装配甲" }, T0 + 21000);
const o1 = arc.getState().orders[oid];
check("换阀后原放行标记失效", o1.releaseVoided === true && !!o1.voidReason?.includes("换阀"));
check("换阀后静置作废 filledAt=null", o1.filledAt === null);
check("换阀后回到可充填（复核通过）", o1.stage === "ready");
check("放行快照仍冻结旧阀体", o1.release?.snapshot.valveNo === "V-9001");
const hist = arc.historyOf("TANK-T1").map((e) => e.kind);
check("履历包含 放行失效 事件", hist.includes("放行失效"));

// 更正扭矩（不换阀）描述
arc.markFilled(oid, T0 + 22000);
arc.submitAssembly(oid, { valveNo: "V-9999", oRingBatch: validBatch, torqueNm: 38, assembler: "装配甲" }, T0 + 23000);
const o1b = arc.getState().orders[oid];
check("更正扭矩后充填作废、进入待重充", o1b.filledAt === null && o1b.stage === "ready");

console.log("5) 刷新 / 重载后队列与履历一致：");
const arc2 = new FillArchive(); // 从同一 localStorage 重新加载
const reloaded = arc2.getState().orders[oid];
check("重载后失效标记保留", reloaded.releaseVoided === true);
check("重载后尝试留痕完整（3 次 +1 次=4）", reloaded.attempts.length === 4);
const histReloaded = arc2.historyOf("TANK-T1");
check("重载后履历条数一致", histReloaded.length === arc.historyOf("TANK-T1").length);

console.log("6) 已放行瓶允许重新入队新单：");
// T1 返工后再次完成静置与签收
arc2.markFilled(oid, T0 + 24000);
const reSign = arc2.signRelease(oid, { reviewer: "复核乙", currentBar: 199 }, T0 + 24000 + REST_MILLIS + 1000);
check("返工后重新签收成功", reSign.ok);
const again = arc2.addOrder(orderDraft({ tankNo: "TANK-T1" }), T0 + 30000);
check("历史已放行瓶可再次入队", again.ok);

console.log(`\n结果：${passed} 通过，${failed} 失败`);
if (failed > 0) process.exit(1);
