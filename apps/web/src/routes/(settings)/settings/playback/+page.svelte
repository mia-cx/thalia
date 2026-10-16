<script lang="ts">
import { toast } from "svelte-sonner";
import { client } from "$lib/api.ts";
import AdminPage from "$lib/components/admin/AdminPage.svelte";
import FormGroup from "$lib/components/admin/FormGroup.svelte";
import FormRow from "$lib/components/admin/FormRow.svelte";
import { Switch } from "$lib/components/ui/switch/index.ts";
import { readFailure } from "$lib/errors.ts";
import { resource } from "$lib/resource.svelte.ts";

type Preference = "preferDirectStream" | "autoplayNextEpisode";

const account = resource(() => client.account.get());
let pending = $state<Partial<Record<Preference, boolean>>>({});
let queue: Promise<unknown> = Promise.resolve();

/** Saves one switch as it flips; writes run in order, and a failure reverts the switch. */
function save(key: Preference, checked: boolean) {
  pending[key] = checked;
  queue = queue.then(async () => {
    try {
      account.set(await client.account.update({ [key]: checked }));
    } catch (error) {
      toast.error(readFailure(error).message);
    } finally {
      delete pending[key];
    }
  });
}
</script>

<AdminPage title="Playback">
  <FormGroup
    loading={account.data === undefined && !account.failure ? 2 : 0}
    failure={account.failure}
  >
    {#if account.data}
      <FormRow
        label="Prefer direct stream"
        for="preferDirectStream"
        hint="Play the best quality as one stream instead of adapting to the connection."
        inline
      >
        <Switch
          id="preferDirectStream"
          checked={pending.preferDirectStream ??
            account.data.preferDirectStream}
          onCheckedChange={(checked) => save("preferDirectStream", checked)}
          disabled={pending.preferDirectStream !== undefined}
        />
      </FormRow>
      <FormRow
        label="Autoplay next episode"
        for="autoplayNextEpisode"
        hint="Play the next episode when one ends."
        inline
      >
        <Switch
          id="autoplayNextEpisode"
          checked={pending.autoplayNextEpisode ??
            account.data.autoplayNextEpisode}
          onCheckedChange={(checked) => save("autoplayNextEpisode", checked)}
          disabled={pending.autoplayNextEpisode !== undefined}
        />
      </FormRow>
    {/if}
  </FormGroup>
</AdminPage>
