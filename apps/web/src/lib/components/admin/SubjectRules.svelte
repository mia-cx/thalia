<script lang="ts">
import { objectHref, type Rule } from "$lib/access.ts";
import FormGroup from "$lib/components/admin/FormGroup.svelte";
import ListRow from "$lib/components/admin/ListRow.svelte";
import { Badge } from "$lib/components/ui/badge/index.ts";
import { Button } from "$lib/components/ui/button/index.ts";
import type { FailureCode } from "$lib/errors.ts";
import { permissionLabels } from "$lib/permissions.ts";

/** Read-only listing of every Access rule naming one user or Group. */
const {
  rules,
  failure,
  loading = false,
  onretry,
}: {
  rules: readonly Rule[] | undefined;
  failure?: { code: FailureCode; message: string };
  loading?: boolean;
  onretry?: () => void;
} = $props();

const kindLabels = {
  movie: "Movie",
  show: "Show",
  season: "Season",
  episode: "Episode",
} as const;

type On<T extends Rule["object"]["type"]> = Rule & {
  object: Extract<Rule["object"], { type: T }>;
};
const on = <T extends Rule["object"]["type"]>(type: T) =>
  (rules ?? []).filter((rule): rule is On<T> => rule.object.type === type);

const grouped = $derived({
  server: on("server"),
  library: on("library"),
  item: on("item"),
});
const empty = $derived(rules !== undefined && rules.length === 0);
</script>

{#snippet badge(rule: Rule)}
  {#if rule.allowed}
    <Badge variant="outline">Allowed</Badge>
  {:else}
    <Badge variant="destructive">Denied</Badge>
  {/if}
{/snippet}

{#if rules === undefined || empty}
  <FormGroup
    title="Access rules"
    loading={rules === undefined && !failure ? 2 : undefined}
    {failure}
  >
    {#if empty}
      <div class="relative min-h-12 px-4 py-2.5">
        <span class="text-subheadline text-label-secondary">No rules yet.</span>
      </div>
    {/if}
    {#snippet actions()}
      {#if failure}
        <Button variant="secondary" onclick={onretry} disabled={loading}
          >Try again</Button
        >
      {/if}
    {/snippet}
  </FormGroup>
{:else}
  {#if grouped.server.length > 0}
    <FormGroup title="Server rules">
      {#each grouped.server as rule (rule.action)}
        <ListRow href="#permissions" title={permissionLabels[rule.action]}>
          {@render badge(rule)}
        </ListRow>
      {/each}
    </FormGroup>
  {/if}
  {#if grouped.library.length > 0}
    <FormGroup title="Library rules">
      {#each grouped.library as rule (`${rule.object.id}:${rule.action}`)}
        <ListRow
          href={objectHref(rule.object) ?? undefined}
          title={rule.object.name}
          caption={permissionLabels[rule.action]}
        >
          {@render badge(rule)}
        </ListRow>
      {/each}
    </FormGroup>
  {/if}
  {#if grouped.item.length > 0}
    <FormGroup title="Item rules">
      {#each grouped.item as rule (`${rule.object.id}:${rule.action}`)}
        <ListRow
          href={objectHref(rule.object) ?? undefined}
          title={rule.object.name}
          caption="{kindLabels[rule.object.kind]} · {permissionLabels[
            rule.action
          ]}"
        >
          {@render badge(rule)}
        </ListRow>
      {/each}
    </FormGroup>
  {/if}
{/if}
