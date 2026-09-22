import "./styles.css";

const project = {
  "sourceNo": 5,
  "id": "hxyfront-62010",
  "port": 62010,
  "title": "潜水气瓶充填记录",
  "domain": "潜水气瓶充填",
  "prompt": "我想做一个给潜水店使用的气瓶充填前端系统，工作人员可以记录气瓶编号、容积、检验有效期、残压、目标压力、氧含量、氦含量、充填方式和操作员。页面需要有待充填队列、混合气比例提示、气瓶检验过期提醒、充填完成签收和单个气瓶历史记录。",
  "palette": [
    "#075985",
    "#0d9488",
    "#f59e0b"
  ],
  "metrics": [
    "待充填",
    "过期提醒",
    "平均氧含量",
    "签收单"
  ],
  "filters": [
    "空气",
    "高氧",
    "Trimix",
    "待检验"
  ],
  "fields": [
    "气瓶编号",
    "容积",
    "检验有效期",
    "残压",
    "目标压力",
    "氧含量"
  ],
  "records": [
    [
      "TANK-204",
      "12L铝瓶",
      "残压55bar，目标200bar",
      "空气充填"
    ],
    [
      "TANK-219",
      "11L钢瓶",
      "EAN32",
      "待客户签收"
    ],
    [
      "TANK-231",
      "双瓶组",
      "检验期剩余12天",
      "标记提醒"
    ]
  ]
};

function App() {
  return (
    <main className="app">
      <section className="hero">
        <p>{project.id} · 源提示词{project.sourceNo} · Port {project.port}</p>
        <h1>{project.title}</h1>
        <span>{project.prompt}</span>
      </section>

      <section className="metrics">
        {project.metrics.map((metric: string, index: number) => (
          <article key={metric}>
            <small>{metric}</small>
            <strong>{[28, 6, 14, 91][index] ?? 10}</strong>
          </article>
        ))}
      </section>

      <section className="workspace">
        <aside className="panel">
          <h2>{project.domain}分类</h2>
          <div className="chips">
            {project.filters.map((item: string) => (
              <button key={item}>{item}</button>
            ))}
          </div>
        </aside>

        <section className="panel form-panel">
          <div className="heading">
            <div>
              <p>专业字段</p>
              <h2>新增记录</h2>
            </div>
            <button className="primary">保存记录</button>
          </div>
          <div className="field-grid">
            {project.fields.map((field: string) => (
              <label key={field}>
                <span>{field}</span>
                <input placeholder={"填写" + field} />
              </label>
            ))}
          </div>
        </section>
      </section>

      <section className="panel">
        <div className="heading">
          <div>
            <p>近期记录</p>
            <h2>工作台摘要</h2>
          </div>
          <button>导出CSV</button>
        </div>
        <div className="records">
          {project.records.map((record: string[], index: number) => (
            <article key={record.join("-")}>
              <b>{String(index + 1).padStart(2, "0")}</b>
              <div>
                <h3>{record[0]}</h3>
                <p>{record.slice(1).join(" · ")}</p>
              </div>
            </article>
          ))}
        </div>
      </section>
    </main>
  );
}

export default App;
