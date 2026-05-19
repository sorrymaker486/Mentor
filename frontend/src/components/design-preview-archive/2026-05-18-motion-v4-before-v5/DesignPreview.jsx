import React, { useEffect, useMemo, useState } from 'react';
import './DesignPreview.css';

const tabs = [
  { id: 'loading', label: '加载页' },
  { id: 'login', label: '登录' },
  { id: 'register', label: '注册' },
  { id: 'forgot', label: '找回密码' },
  { id: 'reset', label: '重置密码' },
  { id: 'subjects', label: '课程看板' },
  { id: 'studio', label: '学习工作室' },
  { id: 'resources', label: '资源生成' },
  { id: 'quiz', label: '章节小测' },
  { id: 'result', label: '结果解析' },
];

const authCopy = {
  login: {
    eyebrow: 'RETURN',
    title: '继续你的学习现场',
    body: '用昵称和密码进入，系统会回到上一次课程节点、学习画像和对话上下文。',
    action: '登录',
    secondary: '找回密码',
    fields: [
      { label: '昵称', value: 'bokuriri' },
      { label: '密码', value: '••••••••', secret: true },
    ],
    side: ['会话恢复', '章节定位', '画像同步'],
  },
  register: {
    eyebrow: 'JOIN',
    title: '创建新的学习身份',
    body: '注册时邮箱必填，昵称唯一；密码只允许规则内字符，提前挡掉无效输入。',
    action: '注册并继续',
    secondary: '返回登录',
    fields: [
      { label: '昵称', value: 'mentor_user', hint: '2-20 位，不能重复' },
      { label: '邮箱', value: 'name@example.com', hint: '用于找回密码' },
      { label: '密码', value: 'Aa123456', hint: '包含大小写字母和数字', secret: true },
    ],
    side: ['唯一昵称', '邮箱绑定', '密码防护'],
  },
  forgot: {
    eyebrow: 'RECOVERY',
    title: '用注册邮箱取回账号',
    body: '只输入注册邮箱。邮件只发送重置令牌，不发送一键链接，减少误点和转发风险。',
    action: '发送重置令牌',
    secondary: '返回登录',
    fields: [{ label: '注册邮箱', value: 'name@example.com', hint: '请检查收件箱和垃圾箱' }],
    side: ['邮箱匹配', '令牌生成', '限频发送'],
  },
  reset: {
    eyebrow: 'RESET',
    title: '设置新昵称和新密码',
    body: '输入邮件中的令牌，同时设置新昵称和新密码；令牌只生效一次。',
    action: '确认重置',
    secondary: '上一步',
    fields: [
      { label: '新昵称', value: 'mentor_new', hint: '同样检查唯一性' },
      { label: '重置令牌', value: 'ABCD-1234-EFGH' },
      { label: '新密码', value: 'Aa123456', secret: true },
      { label: '确认密码', value: 'Aa123456', secret: true },
    ],
    side: ['令牌校验', '昵称更新', '密码写入'],
  },
};

const subjects = [
  { name: '高等数学', meta: '极限 / 导数 / 积分', progress: 78, tone: '#9aaeb4' },
  { name: '计算机组成', meta: 'CPU / 存储 / 指令', progress: 46, tone: '#b4a18d' },
  { name: '自然语言处理', meta: 'Token / 模型 / 评估', progress: 63, tone: '#a9abc7' },
  { name: '操作系统', meta: '进程 / 调度 / 文件', progress: 58, tone: '#99b2a3' },
  { name: '深度学习', meta: '网络 / 优化 / 泛化', progress: 84, tone: '#c0a2a0' },
  { name: '数据库系统', meta: '事务 / 索引 / 查询', progress: 52, tone: '#a7b4c8' },
];

const pathItems = [
  ['导数与链式法则', '完成'],
  ['损失函数', '完成'],
  ['梯度下降', '进行中'],
  ['章节小测', '待解锁'],
];

const resourceCards = [
  ['章节讲义', '把当前对话整理成结构化笔记。'],
  ['错题清单', '抽取薄弱点，生成二次练习入口。'],
  ['概念图谱', '展示公式、概念、例题之间的关系。'],
  ['复习计划', '根据画像安排下一次巩固节奏。'],
];

const quizItems = [
  '梯度消失最常见的表现是什么？',
  '为什么交叉熵常用于分类任务？',
  'Batch Normalization 对训练稳定性的作用是什么？',
  '学习率过大时训练曲线通常会怎样？',
  '过拟合时验证集指标会出现什么变化？',
  'L2 正则化主要约束什么？',
  '反向传播依赖哪条微积分规则？',
  'Softmax 输出可以怎样理解？',
  '激活函数的核心作用是什么？',
  'Dropout 为什么能缓解过拟合？',
  '小批量训练的优势是什么？',
  '损失函数下降不稳定时应先检查什么？',
  '混淆矩阵适合分析什么问题？',
  '迁移学习通常复用模型的哪部分能力？',
  '模型评估为什么不能只看训练集？',
];

const resultItems = [
  {
    ok: true,
    title: '交叉熵损失的目标是提高真实类别概率。',
    answer: '正确',
    explain: '真实类别概率越高，负对数似然越小，损失随之下降。',
  },
  {
    ok: false,
    title: '学习率越大，模型一定越快收敛。',
    answer: '错误',
    explain: '过大的学习率可能越过最优点，造成震荡甚至发散。',
  },
  {
    ok: true,
    title: 'Dropout 可以降低神经元之间的共适应。',
    answer: '正确',
    explain: '训练时随机失活会迫使网络学习更稳健的表示。',
  },
];

const particleCount = 54;
function getInitialTab() {
  if (typeof window === 'undefined') return 'loading';
  const queryTab = new URLSearchParams(window.location.search).get('tab');
  const hashTab = window.location.hash.replace('#', '');
  const candidate = queryTab || hashTab;
  return tabs.some((tab) => tab.id === candidate) ? candidate : 'loading';
}

function AmbientField({ dense = false }) {
  return (
    <div className={`dp2-ambient ${dense ? 'is-dense' : ''}`} aria-hidden>
      <div className="dp2-soft-wash dp2-soft-wash-a" />
      <div className="dp2-soft-wash dp2-soft-wash-b" />
      <div className="dp2-grid-plane" />
      <div className="dp2-grid-scan" />
      <svg className="dp2-line-field" viewBox="0 0 1200 720" preserveAspectRatio="none">
        <path d="M-90 180 C180 80 260 340 520 220 S900 80 1290 210" />
        <path d="M-120 470 C180 330 330 610 580 465 S900 300 1320 440" />
        <path d="M80 760 C220 520 460 580 620 405 S890 110 1240 155" />
        <path d="M-80 80 C180 210 330 80 480 190 S740 410 1260 300" />
      </svg>
      <div className="dp2-thread-grid" />
      <div className="dp2-orbit dp2-orbit-a" />
      <div className="dp2-orbit dp2-orbit-b" />
      <div className="dp2-orbit dp2-orbit-c" />
      {Array.from({ length: particleCount }).map((_, index) => (
        <i
          key={index}
          className="dp2-particle"
          style={{
            '--i': index,
            '--x': `${(index * 37) % 100}%`,
            '--y': `${(index * 61) % 100}%`,
            '--s': `${2 + (index % 4)}px`,
            '--d': `${10 + (index % 9) * 1.6}s`,
            '--delay': `${-(index % 11) * 0.55}s`,
          }}
        />
      ))}
    </div>
  );
}

function CursorParticles() {
  return (
    <div className="dp2-cursor-mark" aria-hidden>
      <span />
      <span />
      <i />
    </div>
  );
}

function PageShell({ children, variant = 'plain' }) {
  return (
    <section className={`dp2-stage dp2-stage-${variant}`}>
      <AmbientField dense={variant !== 'loading'} />
      <div className="dp2-page-transition" />
      <div className="dp2-stage-inner">{children}</div>
    </section>
  );
}

function Button({ children, quiet = false }) {
  return (
    <button className={`dp2-button ${quiet ? 'is-quiet' : ''}`} type="button">
      <span>{children}</span>
    </button>
  );
}

function FieldLine({ field, delay = 0 }) {
  return (
    <label className="dp2-field" style={{ animationDelay: `${delay}ms` }}>
      <span>{field.label}</span>
      <input value={field.value} type={field.secret ? 'password' : 'text'} readOnly />
      {field.hint ? <small>{field.hint}</small> : null}
    </label>
  );
}

function LoadingPage() {
  return (
    <PageShell variant="loading">
      <div className="dp2-loader">
        <div className="dp2-loader-top">
          <span>MENTOR OS</span>
          <span>SESSION PREP</span>
        </div>
        <div className="dp2-loader-nodes" aria-hidden>
          <i />
          <i />
          <i />
        </div>
        <div className="dp2-loader-core">
          <span>正在整理本次学习现场</span>
        </div>
        <div className="dp2-loader-meter" aria-hidden>
          <span />
        </div>
        <div className="dp2-loader-bottom">
          <span>PROFILE</span>
          <strong>节点已连接</strong>
          <span>READY</span>
        </div>
        <div className="dp2-loader-rail" aria-hidden>
          <span>chapter</span>
          <span>memory</span>
          <span>quiz</span>
          <span>resource</span>
        </div>
      </div>
    </PageShell>
  );
}

function AuthPage({ type }) {
  const copy = authCopy[type];
  return (
    <PageShell variant="auth">
      <div className="dp2-auth">
        <aside className="dp2-auth-story">
          <div className="dp2-mini-label">{copy.eyebrow}</div>
          <h2>{copy.title}</h2>
          <p>{copy.body}</p>
          <div className="dp2-short-rule" />
          <div className="dp2-auth-orbits" aria-hidden>
            {copy.side.map((item, index) => (
              <span key={item} style={{ '--i': index }}>
                {item}
              </span>
            ))}
          </div>
        </aside>
        <section className="dp2-auth-form">
          <div className="dp2-form-heading">
            <span>{copy.eyebrow}</span>
            <h3>{copy.action}</h3>
          </div>
          <div className="dp2-form-lines">
            {copy.fields.map((field, index) => (
              <FieldLine key={field.label} field={field} delay={index * 80} />
            ))}
          </div>
          <div className="dp2-actions">
            <Button>{copy.action}</Button>
            <Button quiet>{copy.secondary}</Button>
          </div>
        </section>
      </div>
    </PageShell>
  );
}

function SubjectsPage() {
  return (
    <PageShell variant="subjects">
      <div className="dp2-subjects">
        <section className="dp2-section-title">
          <div className="dp2-mini-label">COURSE BOARD</div>
          <h2>课程入口</h2>
          <p>选择一个方向进入学习。进度以视觉层级表达，不显示生硬数字。</p>
        </section>
        <section className="dp2-subject-list">
          {subjects.map((subject, index) => (
            <button
              key={subject.name}
              className="dp2-subject"
              style={{ '--tone': subject.tone, '--p': `${subject.progress}%`, animationDelay: `${index * 80}ms` }}
              type="button"
            >
              <span className="dp2-subject-index">{String(index + 1).padStart(2, '0')}</span>
              <span>
                <strong>{subject.name}</strong>
                <small>{subject.meta}</small>
              </span>
              <i aria-hidden><b /></i>
            </button>
          ))}
        </section>
      </div>
    </PageShell>
  );
}

function LearningMap() {
  const nodes = [
    [49, 49, 1.2, '核心概念'],
    [30, 28, 0.82, '概念稳定'],
    [72, 31, 0.68, '推理连接'],
    [76, 65, 0.86, '练习完成'],
    [32, 70, 0.74, '表达清晰'],
    [47, 22, 0.56, '复盘'],
    [61, 78, 0.7, '迁移'],
    [18, 49, 0.62, '错题'],
    [85, 47, 0.78, '测试'],
  ];
  const smallNodes = Array.from({ length: 28 }, (_, index) => ({
    x: 16 + ((index * 17) % 72),
    y: 18 + ((index * 29) % 64),
    s: 2 + (index % 3),
    d: index % 9,
  }));
  const edges = [
    [0, 1, -10],
    [0, 2, 12],
    [0, 3, -8],
    [0, 4, 9],
    [1, 5, 6],
    [2, 8, -5],
    [3, 6, 7],
    [4, 7, -7],
    [1, 2, -12],
    [2, 3, 10],
    [3, 4, -10],
    [4, 1, 8],
  ];

  const path = ([from, to, bend]) => {
    const a = nodes[from];
    const b = nodes[to];
    const mx = (a[0] + b[0]) / 2 + bend;
    const my = (a[1] + b[1]) / 2 - bend * 0.45;
    return `M ${a[0]} ${a[1]} Q ${mx} ${my} ${b[0]} ${b[1]}`;
  };

  return (
    <div className="dp2-learning-map">
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden>
        {edges.map((edge, index) => (
          <g key={`${edge[0]}-${edge[1]}`}>
            <path className="dp2-map-edge" d={path(edge)} style={{ animationDelay: `${index * 0.18}s` }} />
            <path className="dp2-map-edge-active" d={path(edge)} style={{ animationDelay: `${index * 0.22}s` }} />
          </g>
        ))}
      </svg>
      {smallNodes.map((node, index) => (
        <span
          key={index}
          className="dp2-map-small-node"
          style={{ left: `${node.x}%`, top: `${node.y}%`, width: node.s, height: node.s, animationDelay: `${node.d * -0.4}s` }}
        />
      ))}
      {nodes.map((node, index) => (
        <span
          key={node[3]}
          className={`dp2-map-node ${index === 0 ? 'is-core' : ''}`}
          style={{ left: `${node[0]}%`, top: `${node[1]}%`, '--scale': node[2], animationDelay: `${index * -0.35}s` }}
        >
          <em>{node[3]}</em>
        </span>
      ))}
    </div>
  );
}

function StudioPage() {
  return (
    <PageShell variant="studio">
      <div className="dp2-studio">
        <aside className="dp2-portrait">
          <div className="dp2-mini-label">LIVE PROFILE</div>
          <LearningMap />
          <p>学习画像随章节推进实时变化：节点亮度代表掌握趋势，连接密度代表知识迁移。</p>
        </aside>
        <main className="dp2-chat">
          <div className="dp2-chat-top">
            <span>AI 学习工作室</span>
            <Button quiet>直接章节测试</Button>
          </div>
          <div className="dp2-dialogue">
            <article className="dp2-bubble">
              你刚才在梯度下降里卡住的是“方向”和“步长”的关系。我们先用一个二维曲面把它拆开。
            </article>
            <article className="dp2-bubble is-user">我能理解方向，但是学习率为什么会导致发散？</article>
            <article className="dp2-bubble">
              把学习率看成每一步的跨度。跨度太大时，模型会越过低点，在两侧来回震荡。
            </article>
          </div>
          <div className="dp2-compose">
            <span>继续追问当前小节...</span>
            <Button>发送</Button>
          </div>
        </main>
        <aside className="dp2-path">
          <div className="dp2-mini-label">CHAPTER FLOW</div>
          {pathItems.map(([name, state], index) => (
            <div key={name} className="dp2-path-item" style={{ animationDelay: `${index * 95}ms` }}>
              <span />
              <strong>{name}</strong>
              <small>{state}</small>
            </div>
          ))}
        </aside>
      </div>
    </PageShell>
  );
}

function ResourcesPage() {
  return (
    <PageShell variant="resources">
      <div className="dp2-resources dp2-resources-v5">
        <section className="dp2-section-title dp2-resource-title">
          <div className="dp2-mini-label">RESOURCE LAB</div>
          <h2>资源生成</h2>
          <p>把当前学习现场整理成可复习、可追踪、可继续的材料。</p>
        </section>
        <section className="dp2-resource-flow">
          {resourceCards.map(([title, body], index) => (
            <button key={title} className="dp2-resource-card" type="button" style={{ animationDelay: `${index * 90}ms` }}>
              <span>{title}</span>
              <strong>{body}</strong>
              <i aria-hidden />
            </button>
          ))}
        </section>
        <aside className="dp2-resource-preview">
          <div>
            <span>OUTPUT STREAM</span>
            <h3>生成队列</h3>
            <p>讲义、错题、图谱和计划会共用同一份学习上下文。</p>
          </div>
          <div className="dp2-actions">
            <Button quiet>查看结构</Button>
            <Button>生成</Button>
          </div>
        </aside>
      </div>
    </PageShell>
  );
}

function QuizPage() {
  return (
    <PageShell variant="quiz">
      <div className="dp2-quiz">
        <section className="dp2-section-title">
          <div className="dp2-mini-label">CHAPTER TEST</div>
          <h2>章节小测</h2>
          <p>题目在同一窗口完成。选项保持清晰，但不破坏背景节奏。</p>
        </section>
        <aside className="dp2-quiz-rail" aria-hidden>
          {quizItems.slice(0, 15).map((_, index) => <span key={index} className={index < 4 ? 'is-live' : ''} />)}
        </aside>
        <section className="dp2-quiz-list">
          {quizItems.map((item, index) => (
            <article key={item} className="dp2-question" style={{ animationDelay: `${index * 35}ms` }}>
              <header>
                <span>{String(index + 1).padStart(2, '0')}</span>
                <p>{item}</p>
              </header>
              <div className="dp2-options">
                <button type="button">A<span>概念判断</span></button>
                <button type="button">B<span>过程推理</span></button>
                <button type="button">C<span>应用迁移</span></button>
                <button type="button">D<span>暂不确定</span></button>
              </div>
            </article>
          ))}
        </section>
        <footer className="dp2-quiz-actions">
          <Button quiet>稍后</Button>
          <Button>提交答案</Button>
        </footer>
      </div>
    </PageShell>
  );
}

function ResultPage() {
  return (
    <PageShell variant="result">
      <div className="dp2-result">
        <section className="dp2-result-hero">
          <div className="dp2-mini-label">RESULT</div>
          <h2>结果解析</h2>
          <p>同一窗口完成判断、解析和下一步巩固。</p>
          <div className="dp2-score-ring" aria-hidden>
            <span>需巩固</span>
          </div>
          <Button>接入 AI 巩固</Button>
        </section>
        <section className="dp2-result-board">
          <div className="dp2-result-status">
            <span>STATUS</span>
            <strong>继续学习</strong>
            <p>错题会回流到知识网络，下一轮对话聚焦薄弱节点。</p>
          </div>
          <div className="dp2-result-list">
            {resultItems.map((item, index) => (
              <article key={item.title} className={`dp2-result-card ${item.ok ? 'is-ok' : 'is-miss'}`} style={{ animationDelay: `${index * 110}ms` }}>
                <span>{item.ok ? '掌握' : '需巩固'}</span>
                <h3>{item.title}</h3>
                <p>答案：{item.answer}</p>
                <small>{item.explain}</small>
              </article>
            ))}
          </div>
          <aside className="dp2-ai-queue">
            <span>AI FOLLOW-UP</span>
            <ol>
              <li>解释震荡原因</li>
              <li>补充同类变式</li>
              <li>重新触发小测</li>
            </ol>
          </aside>
        </section>
      </div>
    </PageShell>
  );
}

const pages = {
  loading: <LoadingPage />,
  login: <AuthPage type="login" />,
  register: <AuthPage type="register" />,
  forgot: <AuthPage type="forgot" />,
  reset: <AuthPage type="reset" />,
  subjects: <SubjectsPage />,
  studio: <StudioPage />,
  resources: <ResourcesPage />,
  quiz: <QuizPage />,
  result: <ResultPage />,
};

export default function DesignPreview() {
  const [active, setActive] = useState(getInitialTab);
  const [pointer, setPointer] = useState({ x: 640, y: 360 });
  const activeLabel = useMemo(() => tabs.find((tab) => tab.id === active)?.label || '加载页', [active]);

  useEffect(() => {
    const nextUrl = `${window.location.pathname}?preview=design#${active}`;
    window.history.replaceState(null, '', nextUrl);
  }, [active]);

  return (
    <div
      className="dp2-root"
      style={{ '--px': `${pointer.x}px`, '--py': `${pointer.y}px` }}
      onPointerMove={(event) => setPointer({ x: event.clientX, y: event.clientY })}
    >
      <CursorParticles />
      <header className="dp2-header">
        <div>
          <strong>Mentor</strong>
          <span>MOTION PREVIEW / {activeLabel}</span>
        </div>
        <nav aria-label="设计预览页面">
          {tabs.map((tab) => (
            <button key={tab.id} className={active === tab.id ? 'is-active' : ''} type="button" onClick={() => setActive(tab.id)}>
              {tab.label}
            </button>
          ))}
        </nav>
      </header>
      <main className="dp2-main" key={active}>
        {pages[active]}
      </main>
    </div>
  );
}
