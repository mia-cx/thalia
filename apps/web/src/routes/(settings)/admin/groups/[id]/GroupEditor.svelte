<script lang="ts">
import { groupSummary } from "$lib/access.ts";
import { client } from "$lib/api.ts";
import AccessPanel from "$lib/components/admin/AccessPanel.svelte";
import AdminPage from "$lib/components/admin/AdminPage.svelte";
import FormGroup from "$lib/components/admin/FormGroup.svelte";
import ListRow from "$lib/components/admin/ListRow.svelte";
import { Button } from "$lib/components/ui/button/index.ts";
import { resource } from "$lib/resource.svelte.ts";

// The route keys this component on the id, so it never outlives its group.
const { id, admin }: { id: string; admin: boolean } = $props();

const list = resource(() => client.groups.list());
const group = $derived((list.data ?? []).find((row) => row.id === id));
const missing = $derived(list.data !== undefined && group === undefined);
const everything = $derived(group?.builtIn === true && group.name === "admins");
</script>

<AdminPage
  title={group?.name ?? "Group"}
  parent={{ href: "/admin/groups", label: "Groups" }}
>
  {#if missing}
    <FormGroup
      failure={{ code: "NOT_FOUND", message: "This group doesn't exist." }}
    />
  {:else if group === undefined}
    <FormGroup
      loading={list.failure ? undefined : 3}
      failure={list.failure ?? undefined}
    >
      {#snippet actions()}
        {#if list.failure}
          <Button
            variant="secondary"
            onclick={() => list.reload()}
            disabled={list.loading}>Try again</Button
          >
        {/if}
      {/snippet}
    </FormGroup>
  {:else if everything || !admin}
    <FormGroup
      title="Access"
      description={admin ? undefined : "Only an admin can change groups."}
    >
      {#if everything}
        <ListRow title="Can do everything" />
      {:else}
        <ListRow title={groupSummary(group)} />
      {/if}
    </FormGroup>
  {:else}
    <div id="permissions" class="scroll-mt-20">
      <AccessPanel subject={{ type: "group", id }} />
    </div>
  {/if}
</AdminPage>
