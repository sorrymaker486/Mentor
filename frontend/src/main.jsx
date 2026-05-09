import { Component, StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'

class RootErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { err: null }
  }

  static getDerivedStateFromError(err) {
    return { err }
  }

  render() {
    if (this.state.err) {
      return (
        <div
          style={{
            minHeight: '100dvh',
            padding: '2rem',
            fontFamily: 'system-ui, sans-serif',
            background: '#faf9f7',
            color: '#1a1f24',
          }}
        >
          <h1 style={{ fontSize: '1.1rem', marginBottom: '0.75rem' }}>页面加载出错</h1>
          <p style={{ fontSize: '0.9rem', opacity: 0.75, marginBottom: '1rem' }}>
            请刷新重试。若持续出现，请把下面错误信息发给开发者。
          </p>
          <pre
            style={{
              fontSize: '12px',
              overflow: 'auto',
              padding: '1rem',
              background: '#fff',
              border: '1px solid rgba(26,31,36,0.12)',
              borderRadius: '8px',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}
          >
            {String(this.state.err?.message || this.state.err)}
          </pre>
        </div>
      )
    }
    return this.props.children
  }
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <RootErrorBoundary>
      <App />
    </RootErrorBoundary>
  </StrictMode>,
)
