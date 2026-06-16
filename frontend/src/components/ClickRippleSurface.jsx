import React, { useEffect, useRef, useState } from 'react';

const RIPPLE_LIFETIME_MS = 760;

export default function ClickRippleSurface({ children, className = '', onPointerDown, ...props }) {
  const [ripples, setRipples] = useState([]);
  const nextId = useRef(0);
  const timers = useRef(new Set());

  useEffect(
    () => () => {
      timers.current.forEach((timer) => window.clearTimeout(timer));
      timers.current.clear();
    },
    []
  );

  const handlePointerDown = (event) => {
    onPointerDown?.(event);
    if (event.defaultPrevented || event.button !== 0) return;

    const id = nextId.current++;
    setRipples((current) => [...current.slice(-5), { id, x: event.clientX, y: event.clientY }]);

    const timer = window.setTimeout(() => {
      setRipples((current) => current.filter((ripple) => ripple.id !== id));
      timers.current.delete(timer);
    }, RIPPLE_LIFETIME_MS);
    timers.current.add(timer);
  };

  return (
    <div className={className} onPointerDown={handlePointerDown} {...props}>
      <div className="dp2-click-ripples" aria-hidden>
        {ripples.map((ripple) => (
          <span
            key={ripple.id}
            className="dp2-click-ripple"
            style={{ left: `${ripple.x}px`, top: `${ripple.y}px` }}
          />
        ))}
      </div>
      {children}
    </div>
  );
}
