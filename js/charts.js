/* ------------------------------------------------------------------
   Hand-rolled SVG charts. No library — the page has to work offline.

   Colours were validated against this dashboard's panel surface
   (#14161A) with the data-viz palette validator: every one clears the
   lightness band, chroma floor and 3:1 contrast, and each pair clears
   the CVD and normal-vision separation floors.

   Single-series charts carry no legend (the title names the series);
   every bar is directly labelled, so colour is never the only channel.
------------------------------------------------------------------- */

const VIZ = {
  revenue: '#DF0000',   /* brand red, single-hue magnitude   */
  fleet:   '#199e70',   /* aqua, single-hue magnitude        */
  status: {             /* reserved status palette + labels  */
    Confirmed: '#3987e5',
    Active:    '#0ca30c',
    Completed: '#9085e9',
    Cancelled: '#d03b3b'
  },
  grid: 'rgba(255,255,255,.07)',
  axis: 'rgba(255,255,255,.20)',
  ink:  'rgba(255,255,255,.46)'
};

/* round a maximum up to something that makes readable ticks */
function niceMax(v) {
  if (v <= 0) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / mag;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * mag;
}

const vEsc = v => String(v ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* Bars get a rounded far end only — the baseline end stays square so
   the mark reads as anchored rather than floating. */
function columnPath(x, y, w, h, r) {
  const rad = Math.max(0, Math.min(r, w / 2, h));
  const base = y + h;
  return `M${x},${base} L${x},${y + rad} Q${x},${y} ${x + rad},${y} `
       + `L${x + w - rad},${y} Q${x + w},${y} ${x + w},${y + rad} L${x + w},${base} Z`;
}

function rowPath(x, y, w, h, r) {
  const rad = Math.max(0, Math.min(r, h / 2, w));
  return `M${x},${y} L${x + w - rad},${y} Q${x + w},${y} ${x + w},${y + rad} `
       + `L${x + w},${y + h - rad} Q${x + w},${y + h} ${x + w - rad},${y + h} L${x},${y + h} Z`;
}

/* ------------------------- column chart -------------------------- */
/* Magnitude over time. One series, one hue, no legend. */
function svgColumns({ data, color, format = v => v, height = 260, width = 1180 }) {
  const W = width, H = height;
  const padL = 66, padR = 16, padT = 18, padB = 36;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  const max = niceMax(Math.max(...data.map(d => d.value), 0));
  const step = plotW / Math.max(data.length, 1);
  const barW = Math.min(38, step * 0.4);

  const ticks = [0, 0.25, 0.5, 0.75, 1].map(t => ({
    y: padT + plotH - t * plotH,
    label: format(Math.round(max * t))
  }));

  return `
  <svg viewBox="0 0 ${W} ${H}" role="img" preserveAspectRatio="xMidYMid meet">
    ${ticks.map(t => `
      <line x1="${padL}" y1="${t.y}" x2="${W - padR}" y2="${t.y}"
            stroke="${t.y === padT + plotH ? VIZ.axis : VIZ.grid}" stroke-width="1"/>
      <text x="${padL - 10}" y="${t.y + 4}" text-anchor="end"
            font-size="10" fill="${VIZ.ink}" style="font-variant-numeric:tabular-nums">${vEsc(t.label)}</text>`).join('')}

    ${data.map((d, i) => {
      const h = max ? (d.value / max) * plotH : 0;
      const x = padL + i * step + (step - barW) / 2;
      const y = padT + plotH - h;
      return `
      <g class="viz-bar" tabindex="0" role="listitem"
         data-label="${vEsc(d.label)}" data-value="${vEsc(format(d.value))}">
        <rect x="${padL + i * step}" y="${padT}" width="${step}" height="${plotH}" fill="transparent"/>
        <path d="${columnPath(x, y, barW, Math.max(h, 0), 4)}" fill="${color}"/>
      </g>
      <text x="${padL + i * step + step / 2}" y="${H - 12}" text-anchor="middle"
            font-size="10" fill="${VIZ.ink}">${vEsc(d.label)}</text>`;
    }).join('')}
  </svg>`;
}

/* --------------------------- bar rows ---------------------------- */
/* Magnitude across named categories. Every row is directly labelled
   with its name and value, so colour never carries meaning alone. */
function svgBars({ data, color, format = v => v, rowH = 40, width = 560 }) {
  const W = width;
  const padL = 108, padR = 56, padT = 6;
  const H = padT * 2 + data.length * rowH;
  const plotW = W - padL - padR;
  const max = Math.max(...data.map(d => d.value), 0) || 1;
  const barH = Math.min(18, rowH - 16);

  return `
  <svg viewBox="0 0 ${W} ${H}" role="img" preserveAspectRatio="xMidYMid meet">
    ${data.map((d, i) => {
      const y = padT + i * rowH + (rowH - barH) / 2;
      const w = Math.max((d.value / max) * plotW, d.value > 0 ? 3 : 0);
      const fill = d.color || color;
      return `
      <g class="viz-bar" tabindex="0" role="listitem"
         data-label="${vEsc(d.label)}" data-value="${vEsc(format(d.value))}">
        <rect x="0" y="${padT + i * rowH}" width="${W}" height="${rowH}" fill="transparent"/>
        <text x="${padL - 12}" y="${y + barH / 2 + 4}" text-anchor="end"
              font-size="11" fill="${VIZ.ink}">${vEsc(d.label)}</text>
        <line x1="${padL}" y1="${padT + i * rowH + 2}" x2="${padL}" y2="${padT + (i + 1) * rowH - 2}"
              stroke="${VIZ.axis}" stroke-width="1"/>
        ${w ? `<path d="${rowPath(padL, y, w, barH, 4)}" fill="${fill}"/>` : ''}
        <text x="${padL + w + 10}" y="${y + barH / 2 + 4}"
              font-size="11" fill="#fff" style="font-variant-numeric:tabular-nums">${vEsc(format(d.value))}</text>
      </g>`;
    }).join('')}
  </svg>`;
}

/* --------------------------- tooltips ---------------------------- */
/* An HTML chart is interactive by default, so every mark gets a hover
   and keyboard-focus readout. */
function initChartTooltips() {
  let tip = document.querySelector('.viz-tip');
  if (!tip) {
    tip = document.createElement('div');
    tip.className = 'viz-tip';
    tip.setAttribute('role', 'status');
    document.body.appendChild(tip);
  }

  const show = el => {
    const box = el.getBoundingClientRect();
    tip.innerHTML = `<b>${el.dataset.label}</b><span>${el.dataset.value}</span>`;
    tip.classList.add('show');
    tip.style.left = `${box.left + box.width / 2}px`;
    tip.style.top = `${box.top - 10}px`;
  };
  const hide = () => tip.classList.remove('show');

  document.querySelectorAll('.viz-bar').forEach(el => {
    el.addEventListener('mouseenter', () => show(el));
    el.addEventListener('focus', () => show(el));
    el.addEventListener('mouseleave', hide);
    el.addEventListener('blur', hide);
  });
  window.addEventListener('scroll', hide, { passive: true });
}
