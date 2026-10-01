<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  export let title: string;
  const dispatch = createEventDispatcher();
</script>

<div class="bar">
  <button class="plain back" on:click={() => dispatch('back')} aria-label="Back">‹ Back</button>
  <h2>{title}</h2>
</div>

<style>
  .bar {
    display: flex;
    align-items: center;
    gap: 4px;
    margin: 0 0 14px -10px;
  }
  .back {
    color: var(--accent);
    font-size: 17px;
    min-width: 76px;
  }
</style>
