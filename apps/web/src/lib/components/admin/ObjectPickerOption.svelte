<script lang="ts">
import CheckIcon from "@lucide/svelte/icons/check";
import { Combobox } from "bits-ui";
import type { PickedObject } from "./ObjectPicker.svelte";

/** One combobox option in the object picker, rendered inside the picker's content. */
const {
  option,
}: {
  option: {
    key: string;
    label: string;
    meta?: string;
    object: PickedObject;
  };
} = $props();
</script>

<Combobox.Item
  value={option.key}
  label={option.label}
  data-slot="combobox-item"
  class="relative flex w-full cursor-default items-center gap-2.5 rounded-sm py-1.5 pr-2.5 pl-7 text-subheadline outline-none select-none data-highlighted:bg-fill-strong data-disabled:pointer-events-none data-disabled:opacity-45"
>
  {#snippet children({ selected })}
    <span
      class="pointer-events-none absolute left-2 flex size-4 items-center justify-center"
    >
      {#if selected}
        <CheckIcon class="pointer-events-none" />
      {/if}
    </span>
    <span class="min-w-0 flex-1">
      <span class="block truncate">{option.label}</span>
      {#if option.meta}
        <span class="block truncate text-footnote text-label-secondary"
          >{option.meta}</span
        >
      {/if}
    </span>
  {/snippet}
</Combobox.Item>
