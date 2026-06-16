import React from 'react';

export default function PasswordVisibilityToggle({
  visible,
  onToggle,
  label = '密码',
}) {
  const action = visible ? '隐藏' : '显示';

  return (
    <button
      type="button"
      className={`dp2-password-toggle ${visible ? 'is-visible' : ''}`}
      onClick={onToggle}
      aria-label={`${action}${label}`}
      aria-pressed={visible}
      title={`${action}${label}`}
    >
      <span className="dp2-password-eye" aria-hidden />
    </button>
  );
}
