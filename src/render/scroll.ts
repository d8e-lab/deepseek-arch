/**
 * 可滚动区域状态（纯计算，无 I/O）
 *
 * 收敛全屏/长列表视图的滚动记账：
 * - offset：当前视口起始行
 * - followTail：是否跟随末尾（新内容到达时自动贴底）
 *
 * 此前该逻辑在 TuiApp 的 Ctrl+O viewer 与 Ctrl+T subagents 视图中
 * 重复实现 2 份（clamp + followTail + 翻页），收口至此。
 */

export interface ScrollStateOptions {
	/** 内容总行数 */
	getTotal(): number;
	/** 视口可见行数 */
	getVisible(): number;
}

export class ScrollState {
	private _offset = 0;
	private _followTail = true;
	private opts: ScrollStateOptions;

	constructor(opts: ScrollStateOptions) {
		this.opts = opts;
	}

	get offset(): number {
		return this._offset;
	}

	get followTail(): boolean {
		return this._followTail;
	}

	/** 最大合法 offset（内容超出视口才可滚动） */
	get maxOffset(): number {
		return Math.max(0, this.opts.getTotal() - this.opts.getVisible());
	}

	/**
	 * 更新内容后校正：若处于跟随末尾或上次贴底，吸附到最新；
	 * 否则仅 clamp 到合法范围（维持用户滚动位置）。
	 * @param forceTail 是否强制回到末尾（如切换条目/新内容到达）
	 */
	reconcile(forceTail = false): void {
		if (forceTail || this._followTail) {
			this._offset = this.maxOffset;
			this._followTail = true;
			return;
		}
		this._offset = Math.min(Math.max(0, this._offset), this.maxOffset);
		if (this._offset >= this.maxOffset) this._followTail = true;
	}

	/** 逐行滚动（用户 ↑↓）；返回是否发生了移动 */
	by(dir: 1 | -1): boolean {
		if (this._offset <= 0 && dir === -1) return false;
		if (this._offset >= this.maxOffset && dir === 1) return false;
		this._followTail = false;
		this._offset += dir;
		this._offset = Math.min(Math.max(0, this._offset), this.maxOffset);
		if (this._offset >= this.maxOffset) this._followTail = true;
		return true;
	}

	/** 翻页滚动（PgUp/PgDn） */
	page(dir: 1 | -1): void {
		const page = Math.max(1, this.opts.getVisible() - 1);
		this._followTail = false;
		this._offset += dir * page;
		this._offset = Math.min(Math.max(0, this._offset), this.maxOffset);
		if (this._offset >= this.maxOffset) this._followTail = true;
	}

	/** 跳到指定行（保证目标行可见）；返回是否发生移动 */
	to(line: number): boolean {
		const target = Math.max(0, Math.min(line, this.maxOffset));
		if (target === this._offset && this._followTail === false) return false;
		this._followTail = false;
		this._offset = target;
		if (this._offset >= this.maxOffset) this._followTail = true;
		return true;
	}
}
