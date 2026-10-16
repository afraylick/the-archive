'use client';

import { useLayoutEffect, useRef, useState } from 'react';

export function SongNotes({ value, onChange, onBlur }: {
  value: string;
  onChange: (value: string) => void;
  onBlur: () => void;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // Keep the existing writing space for the whole editing session if opened empty.
  const [openedEmpty] = useState(() => !value.trim());

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const resize = () => {
      textarea.style.height = 'auto';
      const style = window.getComputedStyle(textarea);
      const border = parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
      textarea.style.height = `${textarea.scrollHeight + border}px`;
    };
    resize();
    let width = textarea.getBoundingClientRect().width;
    const observer = new ResizeObserver(([entry]) => {
      const nextWidth = entry.target.getBoundingClientRect().width;
      if (nextWidth === width) return;
      width = nextWidth;
      resize();
    });
    observer.observe(textarea);
    return () => observer.disconnect();
  }, [value]);

  return <textarea
    ref={textareaRef}
    aria-label="Song notes"
    value={value}
    onChange={event => onChange(event.target.value)}
    onBlur={onBlur}
    rows={1}
    placeholder="Add notes..."
    className={`${openedEmpty ? 'min-h-24' : 'min-h-0'} block w-full resize-y overflow-hidden rounded-md border border-border/65 bg-background/65 p-3 text-sm text-foreground outline-none transition placeholder:text-muted-foreground focus:border-accent`}
  />;
}
