import React, { useEffect, useMemo, useRef, useState } from 'react';
import './DesignPreview.css';

const tabs = [
  ['loading', '加载'],
  ['login', '登录'],
  ['register', '注册'],
  ['forgot', '找回'],
  ['reset', '重置'],
  ['board', '课程'],
  ['studio', '学习'],
  ['resources', '资源'],
  ['quiz', '小测'],
  ['result', '解析'],
];

const authCopy = {
  login: {
    eyebrow: 'RETURN',
    title: '继续学习',
    body: '恢复课程、画像和对话。',
    heading: '账号入口',
    fields: [
      ['昵称', '输入昵称', 'text'],
      ['密码', '输入密码', 'password'],
    ],
    primary: '登录',
    secondary: '找回密码',
    notes: ['课程恢复', '画像同步', '会话延续'],
  },
  register: {
    eyebrow: 'CREATE',
    title: '建立学习身份',
    body: '邮箱必填，昵称唯一。',
    heading: '创建账号',
    fields: [
      ['昵称', '唯一昵称', 'text'],
      ['邮箱', '注册邮箱', 'email'],
      ['密码', '安全密码', 'password'],
    ],
    primary: '注册',
    secondary: '返回登录',
    notes: ['邮箱绑定', '昵称校验', '密码防护'],
  },
  forgot: {
    eyebrow: 'RECOVER',
    title: '邮箱找回',
    body: '用注册邮箱接收重置令牌。',
    heading: '找回密码',
    fields: [['邮箱', '注册邮箱', 'email']],
    primary: '发送令牌',
    secondary: '返回登录',
    notes: ['只发令牌', '邮箱匹配', '过期保护'],
  },
  reset: {
    eyebrow: 'RESET',
    title: '重置账号',
    body: '输入令牌，设置新昵称和新密码。',
    heading: '重置密码',
    fields: [
      ['邮箱', '注册邮箱', 'email'],
      ['令牌', '邮件令牌', 'text'],
      ['新昵称', '可选更新', 'text'],
      ['新密码', '安全密码', 'password'],
    ],
    primary: '确认重置',
    secondary: '重新发送',
    notes: ['令牌验证', '昵称查重', '密码更新'],
  },
};

const subjects = [
  ['高等数学', '极限与导数', 'active', 74],
  ['线性代数', '矩阵空间', 'ready', 52],
  ['概率统计', '随机变量', 'ready', 38],
  ['机器学习', '梯度下降', 'active', 66],
  ['数据结构', '图与搜索', 'ready', 45],
  ['算法设计', '动态规划', 'next', 28],
  ['操作系统', '进程同步', 'next', 34],
  ['计算机网络', '拥塞控制', 'next', 31],
];

const resourceModes = [
  ['讲义', '压缩当前章节', 'brief'],
  ['错题', '定位薄弱节点', 'miss'],
  ['图谱', '连接概念关系', 'map'],
  ['计划', '安排复习节奏', 'plan'],
];

const quizItems = [
  '极限存在的判定条件',
  '导数几何意义',
  '链式法则使用边界',
  '无穷小比较',
  '函数连续性',
  '泰勒展开选点',
  '偏导与方向导数',
  '矩阵秩的含义',
  '特征值稳定性',
  '随机变量期望',
  '方差与标准差',
  '条件概率',
  '梯度下降步长',
  '过拟合识别',
  '模型泛化',
];

const resultCards = [
  ['掌握', '导数定义与切线解释稳定。', 'ok'],
  ['模糊', '无穷小替换缺少条件意识。', 'warn'],
  ['回补', '泰勒展开需要跟随 AI 巩固。', 'miss'],
];

const loadingNodes = ['画像', '节点', '资源', '小测', '解析'];

const mapNodes = [
  ['core', 49, 49, '当前'],
  ['a', 25, 28, '极限'],
  ['b', 67, 25, '导数'],
  ['c', 79, 54, '应用'],
  ['d', 35, 70, '错因'],
  ['e', 58, 78, '复习'],
];

const mapSmallNodes = [
  [18, 45],
  [30, 52],
  [43, 23],
  [53, 33],
  [63, 63],
  [73, 41],
  [84, 72],
  [22, 78],
  [46, 84],
  [72, 85],
  [13, 65],
  [90, 38],
];

const mapEdges = [
  [49, 49, 25, 28],
  [49, 49, 67, 25],
  [67, 25, 79, 54],
  [49, 49, 35, 70],
  [35, 70, 58, 78],
  [25, 28, 43, 23],
  [67, 25, 73, 41],
  [79, 54, 84, 72],
  [58, 78, 72, 85],
  [35, 70, 22, 78],
];

function getInitialTab() {
  if (typeof window === 'undefined') return 'loading';
  const hash = window.location.hash.replace('#', '');
  return tabs.some(([key]) => key === hash) ? hash : 'loading';
}

function AmbientField({ dense = false }) {
  const particles = useMemo(
    () =>
      Array.from({ length: dense ? 48 : 34 }, (_, index) => ({
        left: `${(index * 17 + 11) % 100}%`,
        top: `${(index * 29 + 13) % 100}%`,
        delay: `${(index % 9) * -0.42}s`,
        duration: `${7 + (index % 6) * 1.4}s`,
      })),
    [dense]
  );

  return (
    <div className={`dp2-ambient ${dense ? 'is-dense' : ''}`} aria-hidden>
      <div className="dp2-grid-plane" />
      <div className="dp2-grid-sheen" />
      <div className="dp2-tone dp2-tone-a" />
      <div className="dp2-tone dp2-tone-b" />
      <div className="dp2-tone dp2-tone-c" />
      <svg className="dp2-line-field" viewBox="0 0 1200 720" preserveAspectRatio="none">
        <path d="M-20 188 C160 120 298 230 444 170 C626 96 728 152 885 102 C1010 62 1106 98 1226 54" />
        <path d="M-32 472 C150 380 292 542 458 436 C600 344 728 408 872 330 C1018 250 1116 294 1232 240" />
        <path d="M116 744 C206 588 326 562 442 472 C568 374 602 246 734 196 C850 152 948 180 1108 76" />
        <path d="M-16 610 C170 584 230 494 382 508 C562 526 646 624 828 574 C990 530 1046 432 1220 426" />
      </svg>
      <div className="dp2-ribbon dp2-ribbon-a" />
      <div className="dp2-ribbon dp2-ribbon-b" />
      {particles.map((particle, index) => (
        <i
          key={index}
          className="dp2-particle"
          style={{
            left: particle.left,
            top: particle.top,
            animationDelay: particle.delay,
            animationDuration: particle.duration,
          }}
        />
      ))}
    </div>
  );
}

function CursorTrace() {
  return (
    <div className="dp2-cursor-trace" aria-hidden>
      <i />
      <span />
      <b />
    </div>
  );
}

function PageShell({ children, variant = 'default' }) {
  return (
    <section className={`dp2-stage dp2-stage-${variant}`}>
      <AmbientField dense={variant !== 'loading'} />
      <div className="dp2-page-wipe" />
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

function FieldLine({ label, placeholder, type, delay = 0 }) {
  return (
    <label className="dp2-field" style={{ animationDelay: `${delay}ms` }}>
      <span>{label}</span>
      <input placeholder={placeholder} type={type} />
    </label>
  );
}

function LoadingPage() {
  return (
    <PageShell variant="loading">
      <div className="dp2-loader">
        <div className="dp2-loader-top">
          <span>MENTOR</span>
          <small>同步学习场</small>
        </div>
        <div className="dp2-loader-mid">
          <div>
            <strong>学习场载入</strong>
            <p>连接画像、章节、资源。</p>
          </div>
          <div className="dp2-loader-specks" aria-hidden>
            {loadingNodes.map((node, index) => (
              <i key={node} style={{ '--i': index }}>{node}</i>
            ))}
          </div>
        </div>
        <div className="dp2-loader-meter" aria-hidden>
          <span />
          <b />
        </div>
        <div className="dp2-loader-bottom">
          <small>画像同步</small>
          <small>知识节点</small>
          <small>资源生成</small>
          <small>准备完成</small>
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
          <div className="dp2-auth-constellation" aria-hidden>
            {copy.notes.map((note, index) => (
              <span key={note} style={{ '--i': index }}>{note}</span>
            ))}
          </div>
        </aside>
        <section className="dp2-auth-form">
          <div className="dp2-form-heading">
            <span>ACCOUNT</span>
            <h3>{copy.heading}</h3>
          </div>
          <div className="dp2-form-lines">
            {copy.fields.map(([label, placeholder, fieldType], index) => (
              <FieldLine
                key={label}
                label={label}
                placeholder={placeholder}
                type={fieldType}
                delay={index * 70}
              />
            ))}
          </div>
          <div className="dp2-actions">
            <Button>{copy.primary}</Button>
            <Button quiet>{copy.secondary}</Button>
          </div>
        </section>
      </div>
    </PageShell>
  );
}

function CourseBoardPage() {
  return (
    <PageShell variant="board">
      <div className="dp2-board">
        <section className="dp2-section-title">
          <div className="dp2-mini-label">COURSES</div>
          <h2>课程看板</h2>
          <p>每门课以阶段光带呈现进度，完成后进入章节小测。</p>
        </section>
        <section className="dp2-subject-list">
          {subjects.map(([title, topic, state, progress], index) => (
            <button
              key={title}
              className={`dp2-subject is-${state}`}
              type="button"
              style={{ '--p': `${progress}%`, animationDelay: `${index * 55}ms` }}
            >
              <span>{state === 'active' ? '学习中' : state === 'ready' ? '可进入' : '待开启'}</span>
              <strong>{title}</strong>
              <small>{topic}</small>
              <i aria-label={`${title} 进度`}>
                <b />
              </i>
            </button>
          ))}
        </section>
      </div>
    </PageShell>
  );
}

function LearningMap() {
  const curve = ([x1, y1, x2, y2]) => {
    const mx = (x1 + x2) / 2;
    const my = (y1 + y2) / 2 - 9;
    return `M${x1} ${y1} Q${mx} ${my} ${x2} ${y2}`;
  };

  return (
    <div className="dp2-learning-map">
      <svg viewBox="0 0 100 100" role="img" aria-label="学习画像知识网络">
        {mapEdges.map((edge, index) => (
          <path key={`edge-${index}`} className="dp2-map-edge" d={curve(edge)} style={{ animationDelay: `${index * 0.18}s` }} />
        ))}
        {mapSmallNodes.map(([x, y], index) => (
          <circle key={`small-${index}`} className="dp2-map-small-node" cx={x} cy={y} r={index % 3 === 0 ? 1.7 : 1.1} />
        ))}
        {mapNodes.map(([id, x, y, label], index) => (
          <g key={id} className={`dp2-map-node ${index === 0 ? 'is-core' : ''}`} style={{ animationDelay: `${index * 0.2}s` }}>
            <circle cx={x} cy={y} r={index === 0 ? 4.4 : 3.2} />
            <text x={x + 5} y={y - 4}>{label}</text>
          </g>
        ))}
      </svg>
    </div>
  );
}

function StudioPage() {
  return (
    <PageShell variant="studio">
      <div className="dp2-studio">
        <aside className="dp2-portrait">
          <div className="dp2-mini-label">PROFILE</div>
          <h2>学习画像</h2>
          <p>画像随对话与练习实时漂移。</p>
          <LearningMap />
        </aside>
        <main className="dp2-chat">
          <div className="dp2-chat-top">
            <span>MENTOR</span>
            <Button quiet>章节小测</Button>
          </div>
          <div className="dp2-dialogue">
            <article className="dp2-bubble">
              <span>导师</span>
              梯度下降的关键不是公式背诵，而是理解步长如何改变路径。
            </article>
            <article className="dp2-bubble is-user">
              <span>我</span>
              如果步长过大会发生什么？
            </article>
            <article className="dp2-bubble">
              <span>导师</span>
              会越过低点并震荡。我们先看一段曲线，再进入小测。
            </article>
          </div>
          <div className="dp2-compose">
            <span>输入你的问题</span>
            <Button>发送</Button>
          </div>
        </main>
        <aside className="dp2-study-rail">
          <section className="dp2-plan">
            <div className="dp2-mini-label">PLAN</div>
            <h3>当前阶段</h3>
            <p>理解步长、震荡与收敛条件。</p>
            <ol>
              <li>观察曲线变化</li>
              <li>完成两道变式</li>
              <li>进入章节小测</li>
            </ol>
          </section>
          <section className="dp2-path">
            <div className="dp2-mini-label">目录</div>
            {['概念', '例题', '追问', '小测'].map((item, index) => (
              <div key={item} className="dp2-path-item" style={{ animationDelay: `${index * 80}ms` }}>
                <span />
                <strong>{item}</strong>
                <small>{index < 2 ? '已完成' : index === 2 ? '进行中' : '待开启'}</small>
              </div>
            ))}
          </section>
        </aside>
      </div>
    </PageShell>
  );
}

function ResourcesPage() {
  return (
    <PageShell variant="resources">
      <div className="dp2-resources">
        <section className="dp2-section-title">
          <div className="dp2-mini-label">RESOURCE</div>
          <h2>资源生成</h2>
          <p>从当前章节抽取内容，生成可复习的材料。</p>
        </section>
        <section className="dp2-resource-panel">
          <div className="dp2-resource-modes">
            {resourceModes.map(([title, desc, tone], index) => (
              <button key={title} className={`dp2-resource-mode is-${tone}`} type="button" style={{ animationDelay: `${index * 70}ms` }}>
                <span>{title}</span>
                <small>{desc}</small>
              </button>
            ))}
          </div>
          <div className="dp2-resource-output">
            <span>PREVIEW</span>
            <h3>梯度下降复习包</h3>
            <p>包含关键概念、错因提示、章节图谱和下一轮练习建议。</p>
            <div className="dp2-resource-lines" aria-hidden>
              <i />
              <i />
              <i />
              <i />
            </div>
            <div className="dp2-actions">
              <Button>生成</Button>
              <Button quiet>预览</Button>
            </div>
          </div>
        </section>
      </div>
    </PageShell>
  );
}

function QuizPage() {
  return (
    <PageShell variant="quiz">
      <div className="dp2-quiz">
        <section className="dp2-section-title">
          <div className="dp2-mini-label">TEST</div>
          <h2>章节小测</h2>
          <p>十五题完成后留在当前窗口查看解析。</p>
        </section>
        <section className="dp2-quiz-board">
          <article className="dp2-quiz-focus">
            <span>当前题</span>
            <h3>当学习率过大时，梯度下降更可能出现哪种现象？</h3>
            <div className="dp2-options">
              {['快速收敛到低点', '围绕低点震荡', '梯度恒为零', '损失函数消失'].map((option, index) => (
                <button key={option} type="button" className={index === 1 ? 'is-selected' : ''}>
                  <span>{String.fromCharCode(65 + index)}</span>
                  {option}
                </button>
              ))}
            </div>
          </article>
          <div className="dp2-quiz-strip">
            {quizItems.map((item, index) => (
              <button key={item} type="button" className={index < 5 ? 'is-done' : index === 5 ? 'is-now' : ''}>
                <i />
                <span>{item}</span>
              </button>
            ))}
          </div>
          <footer className="dp2-quiz-actions">
            <Button quiet>稍后</Button>
            <Button>提交答案</Button>
          </footer>
        </section>
      </div>
    </PageShell>
  );
}

function ResultPage() {
  return (
    <PageShell variant="result">
      <div className="dp2-result">
        <section className="dp2-result-hero">
          <div className="dp2-mini-label">REVIEW</div>
          <h2>结果解析</h2>
          <p>未达标时自动衔接 AI 巩固学习。</p>
          <div className="dp2-result-orbit" aria-hidden>
            <span>需巩固</span>
          </div>
        </section>
        <section className="dp2-result-board">
          <div className="dp2-result-track" aria-hidden>
            <i className="is-ok" />
            <i className="is-warn" />
            <i className="is-miss" />
          </div>
          <div className="dp2-result-list">
            {resultCards.map(([title, body, tone], index) => (
              <article key={title} className={`dp2-result-card is-${tone}`} style={{ animationDelay: `${index * 90}ms` }}>
                <span>{title}</span>
                <p>{body}</p>
              </article>
            ))}
          </div>
          <aside className="dp2-ai-queue">
            <span>NEXT</span>
            <h3>AI 巩固路径</h3>
            <ol>
              <li>回看无穷小替换条件</li>
              <li>补做三道变式题</li>
              <li>重新生成章节小测</li>
            </ol>
            <div className="dp2-actions">
              <Button>继续学习</Button>
              <Button quiet>查看解析</Button>
            </div>
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
  board: <CourseBoardPage />,
  studio: <StudioPage />,
  resources: <ResourcesPage />,
  quiz: <QuizPage />,
  result: <ResultPage />,
};

export default function DesignPreview() {
  const [active, setActive] = useState(getInitialTab);
  const rootRef = useRef(null);
  const pointerFrame = useRef(null);

  useEffect(() => {
    const onHashChange = () => setActive(getInitialTab());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const nextUrl = `${window.location.pathname}?preview=design#${active}`;
    window.history.replaceState(null, '', nextUrl);
  }, [active]);

  const handlePointerMove = (event) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    const x = ((event.clientX - bounds.left) / bounds.width) * 100;
    const y = ((event.clientY - bounds.top) / bounds.height) * 100;

    if (pointerFrame.current) cancelAnimationFrame(pointerFrame.current);
    pointerFrame.current = requestAnimationFrame(() => {
      if (!rootRef.current) return;
      rootRef.current.style.setProperty('--mx', `${x}%`);
      rootRef.current.style.setProperty('--my', `${y}%`);
    });
  };

  return (
    <div
      ref={rootRef}
      className="dp2-root"
      onPointerMove={handlePointerMove}
    >
      <CursorTrace />
      <header className="dp2-header">
        <button type="button" className="dp2-brand" onClick={() => setActive('loading')}>
          <strong>Mentor</strong>
          <span>Preview Field</span>
        </button>
        <nav aria-label="设计预览页面">
          {tabs.map(([key, label]) => (
            <button
              key={key}
              type="button"
              className={active === key ? 'is-active' : ''}
              onClick={() => setActive(key)}
            >
              {label}
            </button>
          ))}
        </nav>
      </header>
      <main className="dp2-main" key={active}>
        {pages[active] || pages.loading}
      </main>
    </div>
  );
}
