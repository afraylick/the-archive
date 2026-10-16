'use client';
import { useEffect, useRef, type ReactNode } from 'react';
import s from './library-sidebar.module.css';

export function LibrarySidebar({ children, playerVisible }: { children: ReactNode; playerVisible: boolean }) {
  const idle = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(idle.current), []);
  return <div className={`${s.sidebar} w-full md:sticky md:top-4 md:max-h-[calc(100dvh-2rem)] md:w-72 md:shrink-0 md:overflow-y-auto md:pr-3 ${playerVisible ? 'md:pb-44' : 'md:pb-2'}`} onScroll={event => {
    const sidebar = event.currentTarget;
    sidebar.dataset.scrolling = 'true';
    clearTimeout(idle.current);
    idle.current = setTimeout(() => { delete sidebar.dataset.scrolling; }, 900);
  }}>{children}</div>;
}
