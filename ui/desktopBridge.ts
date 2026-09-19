import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useEffect, useId, useSyncExternalStore } from 'react';
export const isDesktop = isTauri();
export const desktop = <T = any>(command: string, args?: Record<string, unknown>) => invoke<T>(command, args);
export function desktopListen<T>(event: string, callback: (payload: T) => void) {
  let stopped = false;
  let unlisten: (() => void) | undefined;
  if (isDesktop)
    void listen<T>(event, (event) => {
      if (!stopped) callback(event.payload);
    })
      .then((stop) => {
        if (stopped) stop();
        else unlisten = stop;
      })
      .catch(console.error);
  return () => {
    stopped = true;
    unlisten?.();
  };
}
let visible = true;
const listeners = new Set<() => void>();
function setVisible(next: boolean) {
  visible = next;
  document.documentElement.dataset.desktopHidden = String(!next);
  listeners.forEach((listener) => listener());
}
if (isDesktop) {
  desktopListen<boolean>('desktop-visibility', setVisible);
  void desktop('desktop_state')
    .then((state) => setVisible(state.visible))
    .catch(console.error);
}
export function useDesktopVisible() {
  return useSyncExternalStore(
    (callback) => {
      listeners.add(callback);
      return () => {
        listeners.delete(callback);
      };
    },
    () => visible,
  );
}
export function desktopIsVisible() {
  return visible;
}
const drafts = new Map<string, boolean>();
export function useDesktopDraft(dirty: boolean) {
  const id = useId();
  useEffect(() => {
    if (!isDesktop) return;
    drafts.set(id, dirty);
    const sync = () => {
      void desktop('desktop_set_dirty', { dirty: [...drafts.values()].some(Boolean) }).catch(console.error);
    };
    sync();
    return () => {
      drafts.delete(id);
      sync();
    };
  }, [id, dirty]);
}
