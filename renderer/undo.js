'use strict';

const MAX_STEPS = 50;

class UndoHistory {
  constructor() {
    this._stack = [];
    this._idx   = -1;
  }

  // 変更前にスナップショットを取る
  snapshot(surfs) {
    // 現在位置より後の redo ステートを破棄
    this._stack = this._stack.slice(0, this._idx + 1);
    // GL リソース以外のデータのみ深コピー
    const clone = surfs.map(s => ({
      id:             s.id,
      name:           s.name,
      pts:            s.pts.map(p => [...p]),
      opa:            s.opa,
      srcType:        s.srcType,
      srcPath:        s.srcPath,
      srcName:        s.srcName,
      cameraDeviceId: s.cameraDeviceId,
      screenSourceId: s.screenSourceId || null,
    }));
    this._stack.push(clone);
    if (this._stack.length > MAX_STEPS) this._stack.shift();
    else this._idx++;
  }

  undo() {
    if (!this.canUndo()) return null;
    this._idx--;
    return this._deepClone(this._stack[this._idx]);
  }

  redo() {
    if (!this.canRedo()) return null;
    this._idx++;
    return this._deepClone(this._stack[this._idx]);
  }

  canUndo() { return this._idx > 0; }
  canRedo() { return this._idx < this._stack.length - 1; }

  _deepClone(state) {
    return state.map(s => ({ ...s, pts: s.pts.map(p => [...p]) }));
  }
}

module.exports = { UndoHistory };
