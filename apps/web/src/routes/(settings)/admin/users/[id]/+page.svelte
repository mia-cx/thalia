<script lang="ts">
import { untrack } from "svelte";
import { toast } from "svelte-sonner";
import { goto, invalidateAll } from "$app/navigation";
import { page } from "$app/state";
import { client } from "$lib/api.ts";
import { fromMbps, toMbps } from "$lib/bitrate.ts";
import AccessPanel from "$lib/components/admin/AccessPanel.svelte";
import AdminPage from "$lib/components/admin/AdminPage.svelte";
import FormGroup from "$lib/components/admin/FormGroup.svelte";
import FormRow from "$lib/components/admin/FormRow.svelte";
import ListRow from "$lib/components/admin/ListRow.svelte";
import ConfirmDialog from "$lib/components/ConfirmDialog.svelte";
import { Badge } from "$lib/components/ui/badge/index.ts";
import { Button } from "$lib/components/ui/button/index.ts";
import { Input } from "$lib/components/ui/input/index.ts";
import { Switch } from "$lib/components/ui/switch/index.ts";
import { readFailure } from "$lib/errors.ts";
import { resource } from "$lib/resource.svelte.ts";
import type { PageProps } from "./$types";

const { data }: PageProps = $props();

const id = $derived(page.params.id ?? "");

const access = resource(() => client.users.get({ id }));
const groups = resource(() => client.groups.list());
const sessions = resource(() => client.users.sessions({ id }));

let loadedId = untrack(() => id);
$effect(() => {
  if (id === loadedId) return;
  loadedId = id;
  resetRouteState();
  access.clear();
  sessions.clear();
  const target = id;
  const generation = routeGeneration;
  void serial(target, async () => {
    if (!currentVisit(target, generation)) return;
    await Promise.all([access.reload(), sessions.reload()]);
  });
});

type FailureShape = ReturnType<typeof readFailure>;
type SessionRow = NonNullable<typeof sessions.data>[number];

const instant = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});
const at = (value: string | null) =>
  value === null ? "Never" : instant.format(new Date(value));

function sessionState(session: SessionRow): string {
  if (session.revokedAt !== null) return "Revoked";
  const expires = session.expiresAt;
  if (expires !== null && new Date(expires).getTime() <= Date.now())
    return "Expired";
  return "Live";
}

function sessionTitle(session: SessionRow): string {
  if (session.clientName === null) return "Unknown app";
  if (session.deviceName === null) return session.clientName;
  return `${session.clientName} on ${session.deviceName}`;
}

let capInput = $state<string | null>(null);
let ratingInput = $state<string | null>(null);
let preferDirectStream = $state<boolean | null>(null);
let settingsBusy = $state(false);
let settingsFailure = $state<FailureShape | undefined>(undefined);

let groupSel = $state<Record<string, boolean>>({});
let groupsBusy = $state(false);
let groupsFailure = $state<FailureShape | undefined>(undefined);
let leaveAdminsOpen = $state(false);
let leaveConfirmed = $state(false);
let leaveGroupId = $state("");

let revoking = $state<Record<string, boolean>>({});
let revokeFailures = $state<Record<string, FailureShape>>({});

let routeGeneration = 0;
const queues = new Map<string, Promise<unknown>>();

/** Orders writes to one user so the last answer is the last word. */
function serial<T>(target: string, run: () => Promise<T>) {
  const previous = queues.get(target) ?? Promise.resolve();
  const next = previous.then(run, run);
  queues.set(
    target,
    next.catch(() => {}),
  );
  return next;
}

function currentVisit(target: string, generation: number) {
  return target === id && generation === routeGeneration;
}

function resetRouteState() {
  routeGeneration += 1;
  capInput = null;
  ratingInput = null;
  preferDirectStream = null;
  settingsFailure = undefined;
  settingsBusy = false;
  groupSel = {};
  groupsFailure = undefined;
  groupsBusy = false;
  leaveAdminsOpen = false;
  leaveConfirmed = false;
  leaveGroupId = "";
  revoking = {};
  revokeFailures = {};
}

const capValue = $derived(
  capInput ??
    (access.data?.settings.bitrateCapBps == null
      ? ""
      : toMbps(access.data.settings.bitrateCapBps)),
);
const ratingValue = $derived(
  ratingInput ?? access.data?.settings.contentRatingCeiling ?? "",
);
const directStreamValue = $derived(
  preferDirectStream ?? access.data?.settings.preferDirectStream ?? false,
);
const groupsLocked = $derived(
  access.data !== undefined && access.data.user.disabledAt !== null,
);
const adminLocked = $derived(!data.me.admin);
const displayName = $derived(access.data?.user.displayName ?? "User");

async function saveSettings(event: SubmitEvent) {
  const target = id;
  const generation = routeGeneration;
  event.preventDefault();
  settingsBusy = true;
  settingsFailure = undefined;
  try {
    const submittedCap = capValue;
    const submittedRating = ratingValue;
    const capNumber = fromMbps(submittedCap);
    if (capNumber === undefined) {
      settingsFailure = {
        code: "BAD_REQUEST",
        message: "The bitrate cap must be a positive number of Mbit/s.",
      };
      return;
    }
    const rating = submittedRating.trim();
    const submittedDirectStream = directStreamValue;
    const updated = await serial(target, () =>
      client.users.setSettings({
        id: target,
        bitrateCapBps: capNumber,
        contentRatingCeiling: rating === "" ? null : rating,
        preferDirectStream: submittedDirectStream,
      }),
    );
    if (!currentVisit(target, generation)) return;
    access.set(updated);
    if (capInput === submittedCap) capInput = null;
    if (ratingInput === submittedRating) ratingInput = null;
    if (preferDirectStream === submittedDirectStream) preferDirectStream = null;
    toast.success("Playback settings saved");
  } catch (error) {
    if (currentVisit(target, generation)) settingsFailure = readFailure(error);
  } finally {
    if (currentVisit(target, generation)) settingsBusy = false;
  }
}

async function saveGroups(
  groupIds: string[],
  groupName: string,
  added: boolean,
) {
  const target = id;
  const generation = routeGeneration;
  groupsBusy = true;
  groupsFailure = undefined;
  try {
    const updated = await serial(target, () =>
      client.users.setGroups({
        id: target,
        groupIds,
      }),
    );
    if (!currentVisit(target, generation)) return;
    access.set(updated);
    toast.success(
      `${updated.user.displayName} ${added ? "added to" : "removed from"} ${groupName}`,
    );
    if (target === data.me.user.id) {
      await invalidateAll();
      await serial(target, async () => {
        if (!currentVisit(target, generation)) return;
        await Promise.all([
          access.reload(),
          sessions.reload(),
          groups.reload(),
        ]);
      });
    }
  } catch (error) {
    if (currentVisit(target, generation)) groupsFailure = readFailure(error);
  } finally {
    if (currentVisit(target, generation)) {
      groupSel = {};
      groupsBusy = false;
    }
  }
}

type GroupRow = NonNullable<typeof groups.data>[number];

function groupChecked(group: GroupRow): boolean {
  return (
    groupSel[group.id] ?? access.data?.groupIds.includes(group.id) ?? false
  );
}

function toggleGroup(group: GroupRow, checked: boolean) {
  groupSel[group.id] = checked;
  const self = id === data.me.user.id;
  if (self && !checked && group.builtIn && group.name === "admins") {
    leaveGroupId = group.id;
    leaveAdminsOpen = true;
    return;
  }
  const next = checked
    ? [...(access.data?.groupIds ?? []), group.id]
    : (access.data?.groupIds ?? []).filter((one) => one !== group.id);
  void saveGroups(next, group.name, checked);
}

async function leaveAdmins() {
  const admins = (groups.data ?? []).find(
    (group) => group.builtIn && group.name === "admins",
  );
  if (!admins) return;
  leaveConfirmed = true;
  const next = (access.data?.groupIds ?? []).filter((one) => one !== admins.id);
  await saveGroups(next, admins.name, false);
  leaveConfirmed = false;
}

function revertLeave() {
  if (!leaveConfirmed) delete groupSel[leaveGroupId];
}

async function revoke(sessionId: string) {
  const target = id;
  const generation = routeGeneration;
  revoking[sessionId] = true;
  delete revokeFailures[sessionId];
  try {
    await serial(target, () => client.users.revokeSession({ id: sessionId }));
    if (!currentVisit(target, generation)) return;
    await sessions.reload();
    if (!currentVisit(target, generation)) return;
    if (sessions.failure?.code === "UNAUTHORIZED") await goto("/login");
    else toast.success("Session revoked");
  } catch (error) {
    if (currentVisit(target, generation))
      revokeFailures[sessionId] = readFailure(error);
  } finally {
    if (currentVisit(target, generation)) revoking[sessionId] = false;
  }
}
</script>

<AdminPage
  title={displayName}
  parent={{ href: "/admin/users", label: "Users" }}
>
  <FormGroup
    title="Account"
    loading={access.data === undefined && !access.failure ? 4 : undefined}
    failure={access.failure ?? undefined}
  >
    {#if access.data}
      <FormRow label="Username" inline>
        <span class="text-subheadline text-label-secondary"
          >{access.data.user.username}</span
        >
      </FormRow>
      <FormRow label="Email" inline>
        <span class="text-subheadline text-label-secondary"
          >{access.data.user.email ?? "Not set"}</span
        >
      </FormRow>
      <FormRow label="Created" inline>
        <span class="text-subheadline text-label-secondary"
          >{at(access.data.user.createdAt)}</span
        >
      </FormRow>
      <FormRow label="Status" inline>
        <span class="text-subheadline text-label-secondary"
          >{access.data.user.disabledAt === null ? "Active" : "Disabled"}</span
        >
      </FormRow>
    {/if}
    {#snippet actions()}
      {#if access.failure}
        <Button
          variant="secondary"
          onclick={() => access.reload()}
          disabled={access.loading}>Try again</Button
        >
      {/if}
    {/snippet}
  </FormGroup>

  <FormGroup
    title="Sessions"
    loading={sessions.data === undefined && !sessions.failure ? 2 : undefined}
    failure={sessions.failure ??
      (Object.values(revokeFailures).at(-1) || undefined)}
  >
    {#each sessions.data ?? [] as session (session.id)}
      {@const state = sessionState(session)}
      <ListRow
        title={sessionTitle(session)}
        caption="{session.lastSeenAt === null
          ? 'Not seen yet'
          : `Last seen ${at(session.lastSeenAt)}`} · {session.expiresAt ===
        null
          ? "Doesn't expire"
          : `Expires ${at(session.expiresAt)}`}"
      >
        {#if state === "Live"}
          <ConfirmDialog
            title="Revoke this session?"
            description="{sessionTitle(session)} is signed out and has to sign in again."
            action="Revoke session"
            onconfirm={() => revoke(session.id)}
          >
            {#snippet trigger(props)}
              <Button
                {...props}
                variant="ghost"
                size="sm"
                class="text-destructive"
                disabled={revoking[session.id] === true}>Revoke</Button
              >
            {/snippet}
          </ConfirmDialog>
        {:else}
          <Badge>{state}</Badge>
        {/if}
      </ListRow>
    {:else}
      {#if sessions.data !== undefined}
        <div class="relative min-h-12 px-4 py-2.5">
          <span class="text-subheadline text-label-secondary"
            >No sessions.</span
          >
        </div>
      {/if}
    {/each}
    {#snippet actions()}
      {#if sessions.failure}
        <Button
          variant="secondary"
          onclick={() => sessions.reload()}
          disabled={sessions.loading}>Try again</Button
        >
      {/if}
    {/snippet}
  </FormGroup>

  <FormGroup
    title="Playback"
    onsubmit={saveSettings}
    failure={settingsFailure}
    description="Leave a field empty for no limit."
  >
    <FormRow label="Bitrate cap" for="bitrateCap">
      <div class="flex items-center gap-3">
        <Input
          id="bitrateCap"
          name="bitrateCap"
          type="number"
          min="0"
          step="any"
          inputmode="decimal"
          class="w-32"
          value={capValue}
          oninput={(event) => (capInput = event.currentTarget.value)}
          disabled={!access.data}
        />
        <span class="text-subheadline text-label-secondary">Mbit/s</span>
      </div>
    </FormRow>
    <FormRow
      label="Prefer direct stream"
      for="preferDirectStream"
      hint="Play the best quality as one stream instead of adapting to the connection."
    >
      <Switch
        id="preferDirectStream"
        checked={directStreamValue}
        onCheckedChange={(checked) => (preferDirectStream = checked)}
        disabled={!access.data || settingsBusy}
      />
    </FormRow>
    <FormRow label="Content rating ceiling" for="ratingCeiling">
      <Input
        id="ratingCeiling"
        name="ratingCeiling"
        class="w-32"
        value={ratingValue}
        oninput={(event) => (ratingInput = event.currentTarget.value)}
        disabled={!access.data}
      />
    </FormRow>
    {#snippet actions()}
      <Button type="submit" disabled={settingsBusy || !access.data}>Save</Button
      >
    {/snippet}
  </FormGroup>

  <FormGroup
    title="Groups"
    loading={groups.data === undefined && !groups.failure ? 3 : undefined}
    failure={groups.failure ?? groupsFailure}
    description="{groupsLocked
      ? "Group membership can't change while the account is disabled."
      : ''}{adminLocked ? 'Only an admin can change this.' : ''}"
  >
    {#each groups.data ?? [] as group (group.id)}
      <FormRow label={group.name} for="group-{group.id}" inline>
        <Switch
          id="group-{group.id}"
          checked={groupChecked(group)}
          onCheckedChange={(checked) => toggleGroup(group, checked)}
          disabled={groupsBusy || !access.data || groupsLocked || adminLocked}
        />
        {#if group.builtIn}
          <Badge variant="outline">Built in</Badge>
        {/if}
      </FormRow>
    {/each}
    {#snippet actions()}
      {#if groups.failure}
        <Button
          variant="secondary"
          onclick={() => groups.reload()}
          disabled={groups.loading}>Try again</Button
        >
      {/if}
    {/snippet}
  </FormGroup>

  <div id="permissions" class="scroll-mt-20">
    {#if data.me.admin}
      {#key id}
        <AccessPanel subject={{ type: "user", id }} />
      {/key}
    {:else}
      <FormGroup title="Access">
        <ListRow title="Only an admin can change access rules." />
      </FormGroup>
    {/if}
  </div>
</AdminPage>

<ConfirmDialog
  bind:open={leaveAdminsOpen}
  title="Leave the admins group?"
  description="You lose access to these settings as soon as you leave."
  action="Leave group"
  onconfirm={leaveAdmins}
  onclosed={revertLeave}
/>
