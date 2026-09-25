// Tiny typed-ish event bus shared by modules.
type Handler = (payload?: any) => void;

export class Events {
  private map = new Map<string, Set<Handler>>();

  on(name: string, fn: Handler): () => void {
    let s = this.map.get(name);
    if (!s) this.map.set(name, (s = new Set()));
    s.add(fn);
    return () => s!.delete(fn);
  }

  once(name: string, fn: Handler): void {
    const off = this.on(name, (p) => { off(); fn(p); });
  }

  emit(name: string, payload?: any): void {
    const s = this.map.get(name);
    if (!s) return;
    for (const fn of [...s]) {
      try { fn(payload); } catch (e) { console.error(`[events] ${name} handler failed`, e); }
    }
  }
}
