// The status bar (GAME-0002 §8): the four numbers that "never move" -- simulated time, warp,
// clearance post and one-way delay -- each tagged data-readout="status.<field>" (ADR-0004 §2).
// Built once; renderStatus only ever overwrites text content, since panels never animate and
// values change instantly (GAME-0002 §9).
export interface StatusRefs {
  element: HTMLElement;
  time: HTMLElement;
  warp: HTMLElement;
  warpEffective: HTMLElement;
  post: HTMLElement;
  delay: HTMLElement;
}

export interface StatusValues {
  time: string;
  warp: string;
  warpEffective: string;
  post: string;
  delay: string;
}

function field(label: string, readout: string): { wrap: HTMLElement; value: HTMLElement } {
  const wrap = document.createElement('div');
  wrap.className = 'status-field';
  const labelEl = document.createElement('span');
  labelEl.className = 'field-label';
  labelEl.textContent = label;
  const value = document.createElement('span');
  value.className = 'value';
  value.dataset.readout = readout;
  wrap.append(labelEl, value);
  return { wrap, value };
}

export function createStatusBar(): StatusRefs {
  const element = document.createElement('header');
  element.className = 'status-bar';

  const time = field('T', 'status.time');
  const warp = field('WARP', 'status.warp');
  const warpEffective = field('WARP EFF', 'status.warp.effective');
  const post = field('POST', 'status.post');
  const delay = field('DELAY', 'status.delay');

  element.append(time.wrap, warp.wrap, warpEffective.wrap, post.wrap, delay.wrap);

  return {
    element,
    time: time.value,
    warp: warp.value,
    warpEffective: warpEffective.value,
    post: post.value,
    delay: delay.value,
  };
}

export function renderStatus(refs: StatusRefs, values: StatusValues): void {
  refs.time.textContent = values.time;
  refs.warp.textContent = values.warp;
  refs.warpEffective.textContent = values.warpEffective;
  refs.post.textContent = values.post;
  refs.delay.textContent = values.delay;
}
