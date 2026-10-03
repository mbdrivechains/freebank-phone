<script lang="ts">
  // Every house that issues notes (desktop v0.2.5, `houses`): its state and how sound it is, from the chain.
  import { createEventDispatcher, onMount } from 'svelte';
  import type { HouseInfo, PhoneClient, Status } from '../lib/api';
  import { fmtEcx } from '../lib/format';
  import Back from './Back.svelte';

  export let client: PhoneClient;
  export let status: Status;
  const dispatch = createEventDispatcher<{ back: void }>();

  let houses: HouseInfo[] | null = null;
  let loading = false;
  let error = '';

  async function load() {
    if (loading) return;
    loading = true;
    error = '';
    try {
      houses = await client.houses();
    } catch (e) {
      error = (e as Error).message;
    } finally {
      loading = false;
    }
  }
  onMount(() => {
    if (status === 'connected') load();
  });
  let last: Status | null = null;
  $: if (status !== last) {
    if (status === 'connected' && last !== null) load();
    last = status;
  }
</script>

<Back title="Houses" on:back={() => dispatch('back')} />

<section class="stack" data-testid="houses">
  <p class="muted small">Each house's reserves are checked on the chain. A ratio over 100% means more reserves than notes out.</p>
  {#if error}<p class="error small">{error}</p>{/if}
  {#if houses && houses.length === 0}
    <p class="muted">No houses yet on this network.</p>
  {:else if houses}
    {#each houses as h (h.house)}
      <div class="card stack" data-testid="house">
        <div class="top">
          <div>
            <div class="name">{h.name ?? `House #${h.house}`}</div>
            <div class="muted small">House #{h.house}</div>
          </div>
          <span class="badge s-{h.state}">{h.state_name}</span>
        </div>
        <dl class="small">
          {#if h.ratio_bps !== null}<div><dt>Reserve ratio</dt><dd>{(h.ratio_bps / 100).toFixed(0)}%</dd></div>{/if}
          <div><dt>Notes out</dt><dd>{fmtEcx(h.outstanding)} ECX</dd></div>
          {#if h.reserves !== null}<div><dt>Reserves</dt><dd>{fmtEcx(h.reserves)} ECX</dd></div>{/if}
          {#if h.attested_at}<div><dt>Last checked</dt><dd>block {h.attested_at.toLocaleString()}</dd></div>{/if}
          {#if h.state === 'd' && h.rate_bps}<div><dt>Demands earn</dt><dd>{h.rate_bps / 100}% a year</dd></div>{/if}
        </dl>
      </div>
    {/each}
  {:else if status !== 'connected'}
    <p class="muted">Waiting for your desktop…</p>
  {:else if !error}
    <p class="muted"><span class="spinner"></span></p>
  {/if}
</section>

<style>
  .top {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 8px;
  }
  .name {
    font-weight: 650;
    font-size: 17px;
  }
  dl {
    display: grid;
    gap: 4px;
    margin: 0;
  }
  dl div {
    display: flex;
    justify-content: space-between;
    gap: 12px;
  }
  dt {
    color: var(--muted);
  }
  dd {
    margin: 0;
    font-variant-numeric: tabular-nums;
  }
</style>
