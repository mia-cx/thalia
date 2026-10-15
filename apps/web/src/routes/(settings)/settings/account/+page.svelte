<script lang="ts">
import { toast } from "svelte-sonner";
import { invalidateAll } from "$app/navigation";
import { client } from "$lib/api.ts";
import AdminPage from "$lib/components/admin/AdminPage.svelte";
import FormGroup from "$lib/components/admin/FormGroup.svelte";
import FormRow from "$lib/components/admin/FormRow.svelte";
import { Button } from "$lib/components/ui/button/index.ts";
import { Input } from "$lib/components/ui/input/index.ts";
import { readFailure } from "$lib/errors.ts";
import { resource } from "$lib/resource.svelte.ts";

const account = resource(() => client.account.get());

let name = $state<string | null>(null);
let nameBusy = $state(false);

let currentPassword = $state("");
let newPassword = $state("");
let confirmPassword = $state("");
let passwordBusy = $state(false);

async function saveName(event: SubmitEvent) {
  event.preventDefault();
  const displayName = (name ?? account.data?.displayName ?? "").trim();
  if (displayName === "") return;
  nameBusy = true;
  try {
    await client.account.update({ displayName });
    await invalidateAll();
    await account.reload();
    name = null;
    toast.success("Display name saved");
  } catch (error) {
    toast.error(readFailure(error).message);
  } finally {
    nameBusy = false;
  }
}

async function savePassword(event: SubmitEvent) {
  event.preventDefault();
  if (newPassword === "") return;
  if (newPassword !== confirmPassword) {
    toast.error("New passwords do not match");
    return;
  }
  passwordBusy = true;
  try {
    const setting = account.data?.password === "empty";
    await client.account.password({
      currentPassword: setting ? "" : currentPassword,
      newPassword,
    });
    currentPassword = "";
    newPassword = "";
    confirmPassword = "";
    await account.reload();
    toast.success(
      setting
        ? "Password set. Other devices were signed out."
        : "Password changed. Other devices were signed out.",
    );
  } catch (error) {
    toast.error(readFailure(error).message);
  } finally {
    passwordBusy = false;
  }
}
</script>

<AdminPage title="Account">
  <form onsubmit={saveName}>
    <FormGroup title="Profile" loading={account.data === undefined ? 2 : 0}>
      {#if account.data}
        <FormRow label="Display name" for="displayName">
          <Input
            id="displayName"
            name="displayName"
            value={name ?? account.data.displayName}
            oninput={(e) => (name = e.currentTarget.value)}
            maxlength={100}
            required
          />
        </FormRow>
        <FormRow label="Username">
          <p class="px-1 py-2 text-subheadline text-label-secondary">
            {account.data.username}
          </p>
        </FormRow>
      {/if}
      {#snippet actions()}
        <Button type="submit" disabled={nameBusy || account.data === undefined}>
          Save
        </Button>
      {/snippet}
    </FormGroup>
  </form>

  {#if account.data?.password === "external"}
    <FormGroup title="Password">
      <p class="px-4 py-3 text-subheadline text-label-secondary">
        You sign in with single sign-on, so there's no password to change
        here.
      </p>
    </FormGroup>
  {:else}
    <form onsubmit={savePassword}>
      <FormGroup
        title={account.data?.password === "empty"
          ? "Set a password"
          : "Password"}
      >
        {#if account.data?.password === "set"}
          <FormRow label="Current password" for="currentPassword">
            <Input
              id="currentPassword"
              name="currentPassword"
              type="password"
              autocomplete="current-password"
              bind:value={currentPassword}
              required
            />
          </FormRow>
        {/if}
        <FormRow label="New password" for="newPassword">
          <Input
            id="newPassword"
            name="newPassword"
            type="password"
            autocomplete="new-password"
            bind:value={newPassword}
            required
          />
        </FormRow>
        <FormRow label="Confirm password" for="confirmPassword">
          <Input
            id="confirmPassword"
            name="confirmPassword"
            type="password"
            autocomplete="new-password"
            bind:value={confirmPassword}
            required
          />
        </FormRow>
        {#snippet actions()}
          <Button
            type="submit"
            disabled={passwordBusy || account.data === undefined}
          >
            Save
          </Button>
        {/snippet}
      </FormGroup>
    </form>
  {/if}
</AdminPage>
