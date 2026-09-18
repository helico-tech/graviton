// Selection panel and timeline strip (GAME-0002 §8): header only this unit -- GRV-0022 fills in
// readouts once there is a renderer and something selectable to click on.
export function createSelectionPanel(): HTMLElement {
  const element = document.createElement('aside');
  element.className = 'selection-panel';
  const header = document.createElement('h2');
  header.className = 'panel-header';
  header.textContent = 'Selection';
  const placeholder = document.createElement('p');
  placeholder.className = 'placeholder';
  placeholder.textContent = 'No selection';
  element.append(header, placeholder);
  return element;
}

export function createTimelineStrip({ buildSha }: { buildSha: string }): HTMLElement {
  const element = document.createElement('footer');
  element.className = 'timeline-strip';
  const header = document.createElement('h2');
  header.className = 'panel-header';
  header.textContent = 'Timeline';
  const build = document.createElement('span');
  build.className = 'build-tag';
  build.textContent = `GRAVITON build ${buildSha}`;
  element.append(header, build);
  return element;
}
