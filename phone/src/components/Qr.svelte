<script lang="ts">
  // Dark on white with FreeBank's ☉ ghosted in gold under it (qr.ts `qrGhost`).
  import { encodeQr, qrGhost, qrPath } from '../lib/qr';
  export let text: string;
  export let label = 'QR code';
  $: m = encodeQr(text);
  $: q = qrPath(m);
  $: ghost = qrGhost(m);
</script>

<svg class="qr" viewBox="0 0 {q.size} {q.size}" role="img" aria-label={label} shape-rendering="crispEdges" data-testid="qr">
  <rect width={q.size} height={q.size} fill="#ffffff" />
  {#each ghost as g}<path d={g.d} fill={g.fill} />{/each}
  <path d={q.d} fill="#000000" />
</svg>

<style>
  .qr {
    display: block;
    width: 100%;
    max-width: 280px;
    height: auto;
    margin: 0 auto;
    border-radius: 10px;
  }
</style>
