import type { AppContext } from '../../core/context';

export class Power {
  constructor(private ctx: AppContext, private roads: any) {}
  async init(): Promise<void> { /* todo */ }
  update(_dt: number): void { /* todo */ }
}
