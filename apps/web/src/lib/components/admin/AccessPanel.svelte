<script lang="ts">
import MinusIcon from "@lucide/svelte/icons/minus";
import { tick } from "svelte";
import { toast } from "svelte-sonner";
import {
  type AccessObject,
  type AccessSubject,
  kindLabels,
  objectActions,
  objectHref,
  type Rule,
  sourceHref,
} from "$lib/access.ts";
import { client } from "$lib/api.ts";
import FormGroup from "$lib/components/admin/FormGroup.svelte";
import FormRow from "$lib/components/admin/FormRow.svelte";
import ListRow from "$lib/components/admin/ListRow.svelte";
import ObjectPicker, {
  type PickedObject,
} from "$lib/components/admin/ObjectPicker.svelte";
import { Badge } from "$lib/components/ui/badge/index.ts";
import { Button } from "$lib/components/ui/button/index.ts";
import * as Select from "$lib/components/ui/select/index.ts";
import { readFailure } from "$lib/errors.ts";
import { permissionLabels, permissionNames } from "$lib/permissions.ts";
import { resource } from "$lib/resource.svelte.ts";

/** The Access rule editor: with `object` the subject is picked, with `subject` the object is. */
const {
  object,
  subject,
  noun = "item",
}:
  | {
      object: Extract<AccessObject, { id: string }>;
      /** The word the empty state uses, such as "library" or "episode". */
      noun?: string;
      subject?: never;
    }
  | {
      subject: AccessSubject;
      object?: never;
      noun?: never;
    } = $props();

const onObject = resource(async () =>
  object === undefined ? undefined : client.access.rulesOnObject({ object }),
);
const forSubject = resource(async () =>
  subject === undefined
    ? undefined
    : client.access.rulesForSubject({ subject }),
);
const rules = $derived(object !== undefined ? onObject : forSubject);
const objectRules = $derived(onObject.data);
const subjectRules = $derived(forSubject.data);

// The subject picker's lists load only in object mode.
const users = resource(async () =>
  object === undefined ? undefined : client.users.list(),
);
const groups = resource(async () =>
  object === undefined ? undefined : client.groups.list(),
);

type FailureShape = ReturnType<typeof readFailure>;

let removing = $state<Record<string, boolean>>({});
let rulesFailure = $state<
  { objectType: Rule["object"]["type"]; failure: FailureShape } | undefined
>(undefined);
let addFailure = $state<FailureShape | undefined>(undefined);
let addBusy = $state(false);
let subjectSel = $state("");
let objectSel = $state<PickedObject | undefined>(undefined);
let actionSel = $state<Rule["action"]>("view");
let accessSel = $state("allow");
let panel = $state<HTMLElement | null>(null);

const pickableGroups = $derived(
  (groups.data ?? []).filter(
    (group) => !(group.builtIn && group.name === "admins"),
  ),
);

// Server-only Actions are offered only when the rule's object is the server.
const actionOptions = $derived(
  object === undefined && objectSel?.type === "server"
    ? permissionNames
    : objectActions,
);

$effect(() => {
  if (!actionOptions.includes(actionSel)) actionSel = "view";
});

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

// The object key a rule write carries: the fixed object, or the rule's own.
const objectKey = (rule: Rule) =>
  rule.object.type === "server"
    ? ({ type: "server" } as const)
    : ({ type: rule.object.type, id: rule.object.id } as const);

const removeLabel = (rule: Rule) => {
  const label = permissionLabels[rule.action];
  return object !== undefined
    ? `Remove the ${label} rule for ${rule.subject.name}`
    : `Remove the ${label} rule on ${rule.object.type === "server" ? "the server" : rule.object.name}`;
};

// The rules whose rows carry remove buttons, in DOM order.
const removableRules = $derived(
  object !== undefined ? (objectRules?.direct ?? []) : (subjectRules ?? []),
);

async function remove(rule: Rule) {
  const index = removableRules.indexOf(rule);
  removing[ruleKey(rule)] = true;
  rulesFailure = undefined;
  try {
    await client.access.removeRule({
      subject: { type: rule.subject.type, id: rule.subject.id },
      object: object !== undefined ? object : objectKey(rule),
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
      panel?.querySelector<HTMLElement>(
        object !== undefined ? "#access-subject" : "#access-object",
      )
    )?.focus();
  } catch (error) {
    rulesFailure = {
      objectType: rule.object.type,
      failure: readFailure(error),
    };
  } finally {
    removing[ruleKey(rule)] = false;
  }
}

async function addRule(event: SubmitEvent) {
  event.preventDefault();
  let pickedSubject: AccessSubject;
  let pickedObject: Parameters<typeof client.access.setRule>[0]["object"];
  if (object !== undefined) {
    const [type, id] = subjectSel.split(":");
    if ((type !== "user" && type !== "group") || !id) return;
    pickedSubject = { type, id };
    pickedObject = object;
  } else {
    if (objectSel === undefined || subject === undefined) return;
    pickedSubject = subject;
    pickedObject =
      objectSel.type === "server"
        ? { type: "server" }
        : { type: objectSel.type, id: objectSel.id };
  }
  addBusy = true;
  addFailure = undefined;
  try {
    // setRule upserts: re-adding an object and Action replaces its value.
    await client.access.setRule({
      subject: pickedSubject,
      object: pickedObject,
      action: actionSel,
      allowed: accessSel === "allow",
    });
    subjectSel = "";
    objectSel = undefined;
    await rules.reload();
    toast.success("Rule added");
    await tick();
    panel
      ?.querySelector<HTMLElement>(
        object !== undefined ? "#access-subject" : "#access-object",
      )
      ?.focus();
  } catch (error) {
    addFailure = readFailure(error);
  } finally {
    addBusy = false;
  }
}

type On<T extends Rule["object"]["type"]> = Rule & {
  object: Extract<Rule["object"], { type: T }>;
};
const on = <T extends Rule["object"]["type"]>(type: T) =>
  (subjectRules ?? []).filter(
    (rule): rule is On<T> => rule.object.type === type,
  );

const subjectGroups = $derived.by(() => {
  if (object !== undefined || subjectRules === undefined) return undefined;
  return {
    server: on("server"),
    library: on("library"),
    item: on("item"),
  };
});
</script>

{#snippet ruleBadge(rule: Rule)}
  {#if rule.allowed}
    <Badge variant="outline">Allowed</Badge>
  {:else}
    <Badge variant="destructive">Denied</Badge>
  {/if}
{/snippet}

{#snippet removeButton(rule: Rule)}
  <Button
    variant="ghost"
    size="icon-sm"
    aria-label={removeLabel(rule)}
    disabled={removing[ruleKey(rule)] === true}
    data-remove-rule
    onclick={() => remove(rule)}
  >
    <MinusIcon />
  </Button>
{/snippet}

<div bind:this={panel} class="flex flex-col gap-8">
  {#if subject !== undefined}
    {#if subject.type === "user"}
      <p class="px-1 text-footnote text-label-secondary">
        Where this user has no rule, their groups decide.
      </p>
    {/if}
    {#if subjectGroups === undefined || subjectRules?.length === 0}
      <FormGroup
        title="Access rules"
        loading={subjectRules === undefined && !rules.failure
          ? 2
          : undefined}
        failure={rules.failure ?? rulesFailure?.failure}
      >
        {#if subjectRules !== undefined}
          <div class="relative min-h-12 px-4 py-2.5">
            <span class="text-subheadline text-label-secondary"
              >No rules yet.</span
            >
          </div>
        {/if}
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
    {:else}
      {#if subjectGroups.server.length > 0}
        <FormGroup
          title="Server rules"
          failure={rulesFailure?.objectType === "server"
            ? rulesFailure.failure
            : undefined}
        >
          {#each subjectGroups.server as rule (ruleKey(rule))}
            <ListRow title={permissionLabels[rule.action]}>
              {@render ruleBadge(rule)}
              {#snippet actions()}
                {@render removeButton(rule)}
              {/snippet}
            </ListRow>
          {/each}
        </FormGroup>
      {/if}
      {#if subjectGroups.library.length > 0}
        <FormGroup
          title="Library rules"
          failure={rulesFailure?.objectType === "library"
            ? rulesFailure.failure
            : undefined}
        >
          {#each subjectGroups.library as rule (ruleKey(rule))}
            <ListRow
              href={objectHref(rule.object) ?? undefined}
              title={rule.object.name}
              caption={permissionLabels[rule.action]}
            >
              {@render ruleBadge(rule)}
              {#snippet actions()}
                {@render removeButton(rule)}
              {/snippet}
            </ListRow>
          {/each}
        </FormGroup>
      {/if}
      {#if subjectGroups.item.length > 0}
        <FormGroup
          title="Item rules"
          failure={rulesFailure?.objectType === "item"
            ? rulesFailure.failure
            : undefined}
        >
          {#each subjectGroups.item as rule (ruleKey(rule))}
            <ListRow
              href={objectHref(rule.object) ?? undefined}
              title={rule.object.name}
              caption="{kindLabels[rule.object.kind]} · {permissionLabels[
                rule.action
              ]}"
            >
              {@render ruleBadge(rule)}
              {#snippet actions()}
                {@render removeButton(rule)}
              {/snippet}
            </ListRow>
          {/each}
        </FormGroup>
      {/if}
    {/if}
  {:else}
    <FormGroup
      title="Access"
      loading={objectRules === undefined && !rules.failure ? 2 : undefined}
      failure={rules.failure ?? rulesFailure?.failure}
    >
      {#each objectRules?.direct ?? [] as rule (ruleKey(rule))}
        {@const label = permissionLabels[rule.action]}
        <ListRow title={rule.subject.name} caption={directCaption(rule, label)}>
          {@render ruleBadge(rule)}
          {#snippet actions()}
            {@render removeButton(rule)}
          {/snippet}
        </ListRow>
      {:else}
        {#if objectRules !== undefined}
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
  {/if}

  <!-- The first rules read resizes the group above, so a picker opened before it settles would shift under the pointer. -->
  <FormGroup
    title="Add a rule"
    onsubmit={addRule}
    loading={rules.data === undefined && !rules.failure ? 3 : undefined}
    failure={addFailure}
  >
    {#if object !== undefined}
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
    {:else}
      <FormRow label="Server, library or item" for="access-object" inline>
        <ObjectPicker id="access-object" bind:value={objectSel} />
      </FormRow>
    {/if}
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
          {#each actionOptions as action (action)}
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
      <Button
        type="submit"
        disabled={addBusy ||
          (object !== undefined ? subjectSel === "" : objectSel === undefined)}
        >Add rule</Button
      >
    {/snippet}
  </FormGroup>

  {#if object !== undefined && (objectRules?.inherited.length ?? 0) > 0}
    <FormGroup title="Inherited">
      {#each objectRules?.inherited ?? [] as rule (ruleKey(rule))}
        <ListRow
          href={sourceHref(rule) ?? undefined}
          title={rule.subject.name}
          caption={inheritedCaption(rule, permissionLabels[rule.action])}
        >
          {@render ruleBadge(rule)}
        </ListRow>
      {/each}
    </FormGroup>
  {/if}
</div>
