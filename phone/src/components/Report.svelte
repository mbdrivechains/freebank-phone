<script lang="ts">
  // Report a problem, an idea or a security problem: to FreeBank's server (no account), or on GitHub.
  import Back from './Back.svelte';
  import { githubUrl, sendReport, type ReportKind } from '../lib/report';
  import { recentActivity } from '../lib/activity';

  let kind: ReportKind = 'problem';
  let text = '';
  let contact = '';
  let sending = false;
  let sent = '';
  let error = '';
  // "Include recent activity": what this page did lately (lib/activity.ts), shown before it goes.
  let withActivity = false;
  let activity = '';
  $: activity = withActivity ? recentActivity() : '';

  const KINDS: [ReportKind, string][] = [
    ['problem', 'A problem'],
    ['idea', 'An idea'],
    ['security', 'A security problem'],
  ];

  async function send() {
    sending = true;
    error = '';
    try {
      sent = (await sendReport(kind, text, contact, activity)) || '—';
    } catch (e) {
      error = (e as Error).message;
    } finally {
      sending = false;
    }
  }
</script>

<section class="stack" data-testid="report">
  <Back title="Report or suggest" on:back />
  {#if sent}
    <div class="card stack">
      <p>Sent to FreeBank. Thank you. Its reference is <strong class="mono">{sent}</strong>.</p>
      <p class="muted small">Only the FreeBank team reads it.{kind === 'security' ? ' Please keep it to yourself until it is fixed.' : ''}</p>
    </div>
  {:else}
    <form class="card stack" on:submit|preventDefault={send}>
      <div class="kinds" role="radiogroup" aria-label="What is it?">
        {#each KINDS as [k, label]}
          <label class="kind" class:on={kind === k}><input type="radio" name="kind" value={k} bind:group={kind} />{label}</label>
        {/each}
      </div>
      <textarea
        bind:value={text}
        rows="6"
        maxlength="8000"
        aria-label="Your report"
        placeholder={kind === 'idea' ? 'What would you like FreeBank to do?' : 'What you did, what you expected, and what happened instead.'}
      ></textarea>
      <p class="muted small">Leave out addresses, amounts and anything else private.</p>
      <label class="check"><input type="checkbox" bind:checked={withActivity} /> Include recent activity</label>
      {#if withActivity}
        <pre class="activity" data-testid="activity">{activity || 'Nothing yet.'}</pre>
        <p class="muted small">
          What this page did lately: its link to your desktop, each request's outcome, errors. Addresses, transaction
          ids and IP addresses are masked. Only what you see here goes, and only the FreeBank team reads it.
        </p>
      {/if}
      <div>
        <label for="contact">Your email or other contact, if you'd like a reply (optional)</label>
        <input id="contact" bind:value={contact} maxlength="200" autocomplete="email" />
      </div>
      {#if error}<p class="error small">{error}</p>{/if}
      <button class="primary full" type="submit" disabled={sending || !text.trim()}>{sending ? 'Sending…' : 'Send to FreeBank'}</button>
      <p class="muted small">
        No account needed: only the FreeBank team reads it, and nothing goes with it but what you write here and, if
        you include it, the recent activity shown above. With a
        GitHub account you can <a href={githubUrl(kind)} target="_blank" rel="noopener noreferrer"
          >{kind === 'security' ? 'report it privately on GitHub' : 'open it on GitHub'}</a
        >{kind === 'security' ? '' : ' instead (issues there are public)'}.
      </p>
    </form>
  {/if}
</section>

<style>
  .check {
    display: flex;
    align-items: center;
    justify-content: flex-start;
    gap: 10px;
  }
  .check input {
    flex: none;
    width: 20px;
    height: 20px;
    margin: 0;
    padding: 0;
  }
  .activity {
    max-height: 220px;
    overflow: auto;
    margin: 0;
    padding: 10px;
    border-radius: 10px;
    background: var(--card-2, rgba(127, 127, 127, 0.12));
    font-size: 12px;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .kinds {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .kind {
    display: flex;
    align-items: center;
    gap: 6px;
    min-height: 44px;
    padding: 0 12px;
    border-radius: 10px;
    border: 1px solid var(--border);
    font-size: 15px;
  }
  .kind.on {
    border-color: var(--accent);
  }
  /* Not the page's full-width text input. */
  .kind input {
    width: auto;
    min-height: 0;
    margin: 0;
    padding: 0;
    accent-color: var(--accent);
  }
  textarea {
    width: 100%;
    font: inherit;
    font-size: 16px; /* >= 16px so iOS does not zoom */
    padding: 10px 14px;
    border-radius: 12px;
    border: 1px solid var(--border);
    background: var(--inset);
    color: var(--text);
    resize: vertical;
  }
  a {
    color: var(--accent);
  }
</style>
