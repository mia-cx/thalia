<script lang="ts">
import { toast } from "svelte-sonner";
import { page } from "$app/state";
import { client } from "$lib/api.ts";
import AdminPage from "$lib/components/admin/AdminPage.svelte";
import FormGroup from "$lib/components/admin/FormGroup.svelte";
import FormRow from "$lib/components/admin/FormRow.svelte";
import SubjectRules from "$lib/components/admin/SubjectRules.svelte";
import { Button } from "$lib/components/ui/button/index.ts";
import { Switch } from "$lib/components/ui/switch/index.ts";
import { readFailure } from "$lib/errors.ts";
import { cacheSavedGroup } from "$lib/groups.ts";
import {
  type Permission,
  permissionLabels,
  permissionNames,
} from "$lib/permissions.ts";
import { resource } from "$lib/resource.svelte.ts";
import type { PageProps } from "./$types";

const { data }: PageProps = $props();

const id = $derived(page.params.id ?? "");
const adminLocked = $derived(!data.me.admin);

const list = resource(() => client.groups.list());
const group = $derived((list.data ?? []).find((row) => row.id === id));
const missing = $derived(list.data !== undefined && group === undefined);

const rules = resource(() =>
  data.me.admin
    ? client.access.rulesForSubject({ subject: { type: "group", id } })
    : Promise.resolve(undefined),
);

let perms = $state<Permission[] | null>(null);
let busy = $state(false);
let failure = $state<ReturnType<typeof readFailure> | undefined>(undefined);

$effect(() => {
  if (perms === null && group) perms = [...group.permissions];
});

function toggle(permission: Permission, on: boolean) {
  if (perms === null) return;
  perms = on ? [...perms, permission] : perms.filter((p) => p !== permission);
}

async function save(event: SubmitEvent) {
  event.preventDefault();
  if (perms === null || !group) return;
  busy = true;
  failure = undefined;
  const submitted = [...perms];
  try {
    const saved = await client.groups.setPermissions({
      id,
      permissions: submitted,
    });
    await cacheSavedGroup(list, saved);
    await rules.reload();
    toast.success(`${saved.name} saved`);
  } catch (error) {
    failure = readFailure(error);
  } finally {
    busy = false;
  }
}
</script>

<AdminPage
  title={group?.name ?? "Group"}
  parent={{ href: "/admin/groups", label: "Groups" }}
>
  {#if missing}
    <FormGroup
      failure={{ code: "NOT_FOUND", message: "This group doesn't exist." }}
    />
  {:else}
    <div id="permissions" class="scroll-mt-20">
      <FormGroup
        title="Permissions"
        onsubmit={save}
        loading={list.data === undefined && !list.failure ? 3 : undefined}
        failure={list.failure ?? failure}
        description={group?.builtIn
          ? "Built-in groups can't be edited."
          : adminLocked
            ? "Only an admin can change groups."
            : undefined}
      >
        {#if group?.builtIn && group.name === "admins"}
          <div class="relative min-h-12 px-4 py-2.5">
            <span class="text-subheadline text-label-secondary"
              >Can do everything</span
            >
          </div>
        {:else}
          {#each permissionNames as permission (permission)}
            <FormRow
              label={permissionLabels[permission]}
              for="perm-{permission}"
              inline
            >
              <Switch
                id="perm-{permission}"
                checked={perms?.includes(permission) ?? false}
                onCheckedChange={(on) => toggle(permission, on)}
                disabled={busy || adminLocked || (group?.builtIn ?? true)}
              />
            </FormRow>
          {/each}
        {/if}
        {#snippet actions()}
          {#if !(group?.builtIn ?? false)}
            <Button
              type="submit"
              disabled={busy || adminLocked || perms === null}>Save</Button
            >
          {/if}
          {#if list.failure}
            <Button
              variant="secondary"
              onclick={() => list.reload()}
              disabled={list.loading}>Try again</Button
            >
          {/if}
        {/snippet}
      </FormGroup>
    </div>

    {#if data.me.admin}
      <SubjectRules
        rules={rules.data}
        failure={rules.failure ?? undefined}
        loading={rules.loading}
        onretry={() => rules.reload()}
      />
    {/if}
  {/if}
</AdminPage>
