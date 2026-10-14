<script lang="ts">
import MinusIcon from "@lucide/svelte/icons/minus";
import { tick } from "svelte";
import { toast } from "svelte-sonner";
import {
  type AccessObject,
  objectActions,
  type Rule,
  sourceHref,
} from "$lib/access.ts";
import { client } from "$lib/api.ts";
import FormGroup from "$lib/components/admin/FormGroup.svelte";
import FormRow from "$lib/components/admin/FormRow.svelte";
import ListRow from "$lib/components/admin/ListRow.svelte";
import { Badge } from "$lib/components/ui/badge/index.ts";
import { Button } from "$lib/components/ui/button/index.ts";
import * as Select from "$lib/components/ui/select/index.ts";
import { readFailure } from "$lib/errors.ts";
import { permissionLabels } from "$lib/permissions.ts";
import { resource } from "$lib/resource.svelte.ts";

const {
  object,
  noun = "item",
}: {
  object: Extract<AccessObject, { id: string }>;
  /** The word the empty state uses, such as "library" or "episode". */
  noun?: string;
} = $props();

const rules = resource(() => client.access.rulesOnObject({ object }));
const users = resource(() => client.users.list());
const groups = resource(() => client.groups.list());

type FailureShape = ReturnType<typeof readFailure>;

let removing = $state<Record<string, boolean>>({});
let rulesFailure = $state<FailureShape | undefined>(undefined);
let addFailure = $state<FailureShape | undefined>(undefined);
let addBusy = $state(false);
let subjectSel = $state("");
let actionSel = $state<Rule["action"]>("view");
let accessSel = $state("allow");
let panel = $state<HTMLElement | null>(null);

const pickableGroups = $derived(
  (groups.data ?? []).filter(
    (group) => !(group.builtIn && group.name === "admins"),
  ),
);

const ruleKey = (rule: Rule) =>
  `${rule.object.type}:${"id" in rule.object ? rule.object.id : ""}:${rule.subject.type}:${rule.subject.id}:${rule.action}`;

const subjectLabel = $derived.by(() => {
  const [type, id] = subjectSel.split(":");
  if (type === "user") {
    const user = (users.data ?? []).find((user) => user.id === id);
    return user && `${user.displayName} (@${user.username})`;
  }
  if (type === "group")
    return pickableGroups.find((group) => group.id === id)?.name;
  return undefined;
});

// displayName is not unique, so user subjects name themselves by username.
const userLabel = (rule: Rule) =>
  rule.subject.type === "user"
    ? (users.data ?? []).find((user) => user.id === rule.subject.id)?.username
    : undefined;

const directCaption = (rule: Rule, label: string) =>
  rule.subject.type === "group"
    ? `Group · ${label}`
    : userLabel(rule) !== undefined
      ? `@${userLabel(rule)} · ${label}`
      : `User · ${label}`;

const inheritedCaption = (rule: Rule, label: string) =>
  rule.subject.type === "user" && userLabel(rule) !== undefined
    ? `@${userLabel(rule)} · ${label} · from ${source(rule)}`
    : `${label} · from ${source(rule)}`;

const source = (rule: Rule) =>
  rule.object.type === "server" ? "the server" : rule.object.name;

async function remove(rule: Rule, index: number) {
  removing[ruleKey(rule)] = true;
  rulesFailure = undefined;
  try {
    await client.access.removeRule({
      subject: { type: rule.subject.type, id: rule.subject.id },
      object,
      action: rule.action,
    });
    await rules.reload();
    toast.success("Rule removed");
    await tick();
    const buttons = [
      ...(panel?.querySelectorAll<HTMLButtonElement>("[data-remove-rule]") ??
        []),
    ];
    (
      buttons[index] ??
      buttons[index - 1] ??
      panel?.querySelector<HTMLElement>("#access-subject")
    )?.focus();
  } catch (error) {
    rulesFailure = readFailure(error);
  } finally {
    removing[ruleKey(rule)] = false;
  }
}

async function addRule(event: SubmitEvent) {
  event.preventDefault();
  const [type, id] = subjectSel.split(":");
  if ((type !== "user" && type !== "group") || !id) return;
  addBusy = true;
  addFailure = undefined;
  try {
    await client.access.setRule({
      subject: { type, id },
      object,
      action: actionSel,
      allowed: accessSel === "allow",
    });
    subjectSel = "";
    await rules.reload();
    toast.success("Rule added");
    await tick();
    panel?.querySelector<HTMLElement>("#access-subject")?.focus();
  } catch (error) {
    addFailure = readFailure(error);
  } finally {
    addBusy = false;
  }
}
</script>

<div bind:this={panel} class="flex flex-col gap-8">
  <FormGroup
    title="Access"
    loading={rules.data === undefined && !rules.failure ? 2 : undefined}
    failure={rules.failure ?? rulesFailure}
  >
    {#each rules.data?.direct ?? [] as rule, index (ruleKey(rule))}
      {@const label = permissionLabels[rule.action]}
      <ListRow title={rule.subject.name} caption={directCaption(rule, label)}>
        {#if rule.allowed}
          <Badge variant="outline">Allowed</Badge>
        {:else}
          <Badge variant="destructive">Denied</Badge>
        {/if}
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Remove the {label} rule for {rule.subject.name}"
          disabled={removing[ruleKey(rule)] === true}
          data-remove-rule
          onclick={() => remove(rule, index)}
        >
          <MinusIcon />
        </Button>
      </ListRow>
    {:else}
      {#if rules.data !== undefined}
        <div class="relative min-h-12 px-4 py-2.5">
          <span class="text-subheadline text-label-secondary"
            >No rules on this {noun}.</span
          >
        </div>
      {/if}
    {/each}
    {#snippet actions()}
      {#if rules.failure}
        <Button
          variant="secondary"
          onclick={() => rules.reload()}
          disabled={rules.loading}>Try again</Button
        >
      {/if}
    {/snippet}
  </FormGroup>

  <FormGroup title="Add a rule" onsubmit={addRule} failure={addFailure}>
    <FormRow label="User or group" for="access-subject" inline>
      <Select.Root
        type="single"
        value={subjectSel}
        onValueChange={(next) => (subjectSel = next)}
      >
        <Select.Trigger id="access-subject">
          <Select.Value
            >{subjectLabel ?? "Pick a user or group"}</Select.Value
          >
        </Select.Trigger>
        <Select.Content>
          <Select.Group>
            <Select.GroupHeading>Users</Select.GroupHeading>
            {#each users.data ?? [] as user (user.id)}
              <Select.Item
                value="user:{user.id}"
                label="{user.displayName} (@{user.username})"
                >{user.displayName}
                <span class="text-label-secondary">@{user.username}</span
                ></Select.Item
              >
            {/each}
          </Select.Group>
          <Select.Group>
            <Select.GroupHeading>Groups</Select.GroupHeading>
            {#each pickableGroups as group (group.id)}
              <Select.Item value="group:{group.id}" label={group.name}
                >{group.name}</Select.Item
              >
            {/each}
          </Select.Group>
        </Select.Content>
      </Select.Root>
    </FormRow>
    <FormRow label="Action" for="access-action" inline>
      <Select.Root
        type="single"
        value={actionSel}
        onValueChange={(next) => (actionSel = next as Rule["action"])}
      >
        <Select.Trigger id="access-action">
          <Select.Value>{permissionLabels[actionSel]}</Select.Value>
        </Select.Trigger>
        <Select.Content>
          {#each objectActions as action (action)}
            <Select.Item value={action} label={permissionLabels[action]}
              >{permissionLabels[action]}</Select.Item
            >
          {/each}
        </Select.Content>
      </Select.Root>
    </FormRow>
    <FormRow label="Access" for="access-access" inline>
      <Select.Root
        type="single"
        value={accessSel}
        onValueChange={(next) => (accessSel = next)}
      >
        <Select.Trigger id="access-access">
          <Select.Value>{accessSel === "allow" ? "Allow" : "Deny"}</Select.Value
          >
        </Select.Trigger>
        <Select.Content>
          <Select.Item value="allow" label="Allow">Allow</Select.Item>
          <Select.Item value="deny" label="Deny">Deny</Select.Item>
        </Select.Content>
      </Select.Root>
    </FormRow>
    {#snippet actions()}
      <Button type="submit" disabled={addBusy || subjectSel === ""}
        >Add rule</Button
      >
    {/snippet}
  </FormGroup>

  {#if (rules.data?.inherited.length ?? 0) > 0}
    <FormGroup title="Inherited">
      {#each rules.data?.inherited ?? [] as rule (ruleKey(rule))}
        <ListRow
          href={sourceHref(rule) ?? undefined}
          title={rule.subject.name}
          caption={inheritedCaption(rule, permissionLabels[rule.action])}
        >
          {#if rule.allowed}
            <Badge variant="outline">Allowed</Badge>
          {:else}
            <Badge variant="destructive">Denied</Badge>
          {/if}
        </ListRow>
      {/each}
    </FormGroup>
  {/if}
</div>
