<script lang="ts" module>
/** The object an add-rule form can target. */
export type PickedObject =
  | { type: "server" }
  | { type: "library"; id: string; name: string }
  | { type: "item"; id: string; name: string };
</script>

<script lang="ts">
import { Combobox } from "bits-ui";
import { onDestroy } from "svelte";
import { client } from "$lib/api.ts";
import { kindLabels } from "$lib/access.ts";
import { resource } from "$lib/resource.svelte.ts";
import ObjectPickerOption from "./ObjectPickerOption.svelte";

/** A searchable object picker listing the Server, Libraries and Items. */
let {
  id,
  value = $bindable(undefined),
}: {
  id?: string;
  value?: PickedObject;
} = $props();

type Option = {
  key: string;
  label: string;
  meta?: string;
  object: PickedObject;
};

let input = $state("");
let open = $state(false);
let sel = $state("");

const libraries = resource(() => client.libraries.list());

type SearchCard = Awaited<ReturnType<typeof client.items.search>>[number];

let items = $state<
  { query: string; cards: readonly SearchCard[] } | undefined
>(undefined);
// The query the item search last failed for, so a retry can clear it.
let failedQuery = $state<string | undefined>(undefined);
let generation = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
onDestroy(() => clearTimeout(timer));

const query = $derived(input.trim());
const libraryOptions = $derived(
  (libraries.data ?? [])
    .filter((library) =>
      library.name.toLowerCase().includes(query.toLowerCase()),
    )
    .map(
      (library): Option => ({
        key: `library:${library.id}`,
        label: library.name,
        object: { type: "library", id: library.id, name: library.name },
      }),
    ),
);
const itemOptions = $derived(
  (items?.cards ?? []).map((card): Option => {
    const meta = [
      kindLabels[card.kind],
      ...(card.show === null ? [] : [card.show.title]),
      ...(card.year === null ? [] : [String(card.year)]),
    ].join(" · ");
    return {
      key: `item:${card.id}`,
      label: card.title,
      meta,
      object: { type: "item", id: card.id, name: card.title },
    };
  }),
);
const serverOption: Option = {
  key: "server",
  label: "Server",
  object: { type: "server" },
};
const optionList = $derived([
  serverOption,
  ...libraryOptions,
  ...itemOptions,
]);
const showServer = $derived(
  query === "" || "server".includes(query.toLowerCase()),
);
// The current query's item search answered with no matches anywhere.
const none = $derived(
  query !== "" &&
    !showServer &&
    libraryOptions.length === 0 &&
    itemOptions.length === 0 &&
    items?.query === query &&
    failedQuery !== query,
);
const itemsFailed = $derived(failedQuery === query);

// Items come from the API, debounced so typing does not fan out requests.
$effect(() => {
  const asked = query;
  clearTimeout(timer);
  if (asked === "") {
    generation += 1;
    items = undefined;
    return;
  }
  timer = setTimeout(() => {
    const ticket = ++generation;
    client.items
      .search({
        query: asked,
        kinds: ["movie", "show", "season", "episode"],
      })
      .then((cards) => {
        if (ticket !== generation) return;
        items = { query: asked, cards };
        failedQuery = undefined;
      })
      .catch(() => {
        if (ticket === generation) failedQuery = asked;
      });
  }, 150);
});

$effect(() => {
  if (input === "" && value !== undefined) {
    sel = "";
    value = undefined;
  }
});

function pick(next: string) {
  const option = optionList.find((entry) => entry.key === next);
  if (option === undefined) return;
  sel = next;
  value = option.object;
  input = option.label;
  open = false;
}
</script>

<Combobox.Root
  type="single"
  value={sel}
  onValueChange={pick}
  inputValue={input}
  onOpenChange={(next) => (open = next)}
  {open}
>
  <Combobox.Input
    {id}
    placeholder="Search libraries and items"
    autocomplete="off"
    class="h-10 w-full min-w-0 rounded-md bg-fill px-3 text-subheadline text-label outline-none transition-colors placeholder:text-label-secondary focus:bg-fill-strong"
    oninput={(event) => {
      input = event.currentTarget.value;
      open = true;
    }}
    onfocus={() => (open = true)}
  />
  <Combobox.Portal>
    <Combobox.Content
      sideOffset={4}
      class="outline-none material-thick text-label data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-97 data-[state=open]:duration-(--duration-fast) data-[state=open]:ease-smooth-out data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-99 data-[state=closed]:duration-(--duration-quick) relative z-50 max-h-(--bits-floating-available-height) min-w-(--bits-floating-anchor-width) origin-(--bits-floating-transform-origin) overflow-x-hidden overflow-y-auto rounded-lg p-1.5 shadow-float"
    >
      {#if showServer}
        <ObjectPickerOption option={serverOption} />
      {/if}
      {#if libraryOptions.length > 0}
        <Combobox.Group>
          <Combobox.GroupHeading
            class="px-2.5 pt-1.5 pb-1 text-footnote font-semibold text-label-secondary"
            >Libraries</Combobox.GroupHeading
          >
          {#each libraryOptions as library (library.key)}
            <ObjectPickerOption option={library} />
          {/each}
        </Combobox.Group>
      {/if}
      {#if itemsFailed}
        <Combobox.Group>
          <Combobox.GroupHeading
            class="px-2.5 pt-1.5 pb-1 text-footnote font-semibold text-label-secondary"
            >Items</Combobox.GroupHeading
          >
          <div
            class="relative flex w-full items-center rounded-sm py-1.5 pr-2.5 pl-7 text-subheadline text-label-secondary select-none"
          >
            Couldn't search items. Keep typing to try again.
          </div>
        </Combobox.Group>
      {:else if itemOptions.length > 0}
        <Combobox.Group>
          <Combobox.GroupHeading
            class="px-2.5 pt-1.5 pb-1 text-footnote font-semibold text-label-secondary"
            >Items</Combobox.GroupHeading
          >
          {#each itemOptions as item (item.key)}
            <ObjectPickerOption option={item} />
          {/each}
        </Combobox.Group>
      {/if}
      {#if none}
        <div
          class="relative flex w-full items-center rounded-sm py-1.5 pr-2.5 pl-7 text-subheadline text-label-secondary select-none"
        >
          No matches
        </div>
      {/if}
    </Combobox.Content>
  </Combobox.Portal>
</Combobox.Root>
