import { Select } from "@inkjs/ui";
import { Box, Text, useInput } from "ink";
import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { ProviderEntry } from "../config/config.ts";
import type { Color } from "../core/ansi.ts";
import { SPINNER_FRAMES, SPINNER_INTERVAL } from "../core/spinner.ts";
import { API_PROVIDERS, CLI_PROVIDERS } from "../llm/providers/registry.ts";
import type { ModelsDevData } from "../wizard/models-filter.ts";
import { initWizardState, reduce, type WizardAction } from "../wizard/state.ts";
import type { Badge } from "./border.ts";
import { Checklist, type ChecklistItem } from "./checklist.tsx";
import { Dialog } from "./dialog.tsx";
import { TextInput } from "./text-input.tsx";

type HintItem = { combo: string; label: string; primary?: boolean };

function KeyHints({ items }: { items: readonly HintItem[] }) {
  return (
    <Text>
      <Text>{"  "}</Text>
      {items.map((item, i) => (
        <Text key={item.combo}>
          {i > 0 ? <Text color="#414150">{"  │  "}</Text> : null}
          <Text bold color={item.primary ? "#f5c864" : "#aaaac3"}>
            {item.combo}
          </Text>
          <Text color="#73738c">{` ${item.label}`}</Text>
        </Text>
      ))}
    </Text>
  );
}

const WIZARD_STOPS: Color[] = [
  [120, 180, 255],
  [100, 150, 240],
  [90, 120, 210],
  [80, 100, 180],
  [70, 80, 150],
  [60, 60, 100],
];

const WIZARD_BADGE: Badge = {
  fg: [180, 210, 255],
  bg: [30, 50, 90],
  icon: "🧙",
  label: "setup wizard",
};

const CONTENT_WIDTH = 70;
const MAX_VISIBLE_OPTIONS = 8;

export type WizardCallbacks = {
  fetchModels: () => Promise<ModelsDevData>;
  probeCliBinaries: () => Record<string, boolean>;
  onDone: (entries: Record<string, ProviderEntry>, defaultProvider: string) => void;
  onCancel: () => void;
};

export function ConfigWizardDialog({
  fetchModels,
  probeCliBinaries,
  onDone,
  onCancel,
}: WizardCallbacks) {
  const [state, dispatch] = useReducer(reduce, undefined, initWizardState);
  const [cliAvailable, setCliAvailable] = useState<Record<string, boolean>>({});
  const doneRef = useRef(false);

  useEffect(() => {
    setCliAvailable(probeCliBinaries());
  }, [probeCliBinaries]);

  useEffect(() => {
    if (state.screen.tag === "loading-models") {
      fetchModels()
        .then((data) => dispatch({ type: "models-fetched", data }))
        .catch((err) => {
          onCancel();
          throw err;
        });
    }
  }, [state.screen.tag, fetchModels, onCancel]);

  useEffect(() => {
    if (state.screen.tag === "done" && !doneRef.current) {
      doneRef.current = true;
      onDone(state.builtEntries, state.defaultProvider as string);
    }
  }, [state.screen.tag, state.builtEntries, state.defaultProvider, onDone]);

  useInput(
    (_input, key) => {
      if (key.escape) {
        if (state.screen.tag === "disclaimer") {
          dispatch({ type: "skip-disclaimer" });
        } else {
          onCancel();
        }
      }
    },
    { isActive: state.screen.tag !== "done" },
  );

  const { screen } = state;
  let bottomStatus: string | undefined;
  if (screen.tag === "loading-models") {
    bottomStatus = "Loading models list…";
  }

  return (
    <Dialog
      gradientStops={WIZARD_STOPS}
      badge={WIZARD_BADGE}
      bottomStatus={bottomStatus}
      naturalContentWidth={CONTENT_WIDTH}
    >
      {screen.tag === "selecting-providers" && (
        <ProviderSelectionScreen
          checked={screen.checked}
          cliAvailable={cliAvailable}
          dispatch={dispatch}
        />
      )}
      {screen.tag === "loading-models" && <LoadingScreen />}
      {screen.tag === "entering-key" && (
        <ApiKeyScreen provider={screen.provider} draft={screen.draft} dispatch={dispatch} />
      )}
      {screen.tag === "picking-model" && (
        <ModelPickerScreen
          provider={screen.provider}
          models={screen.models}
          cursor={screen.cursor}
          dispatch={dispatch}
        />
      )}
      {screen.tag === "disclaimer" && <DisclaimerScreen dispatch={dispatch} />}
      {screen.tag === "picking-default" && (
        <DefaultPickerScreen
          providers={state.pickedProviders}
          cursor={screen.cursor}
          dispatch={dispatch}
        />
      )}
    </Dialog>
  );
}

function ProviderSelectionScreen({
  checked,
  cliAvailable,
  dispatch,
}: {
  checked: Set<string>;
  cliAvailable: Record<string, boolean>;
  dispatch: React.Dispatch<WizardAction>;
}) {
  const hasAnyCli = Object.values(cliAvailable).some(Boolean);

  const items = useMemo(() => {
    const list: ChecklistItem[] = [{ type: "header", label: "Select API Provider(s)" }];
    for (const [name, p] of Object.entries(API_PROVIDERS)) {
      list.push({ type: "option", label: p.displayName, value: name });
    }
    if (hasAnyCli) {
      list.push({ type: "header", label: "Use your coding agent's subscription" });
      for (const [name, p] of Object.entries(CLI_PROVIDERS)) {
        if (cliAvailable[name]) {
          list.push({ type: "option", label: p.displayName, value: name });
        }
      }
    }
    return list;
  }, [hasAnyCli, cliAvailable]);

  const handleToggle = (value: string) => {
    dispatch({ type: "toggle-provider", name: value });
  };

  const handleSubmit = (values: string[]) => {
    // Sync reducer checked state with the submitted values
    for (const name of [...checked]) {
      if (!values.includes(name)) dispatch({ type: "toggle-provider", name });
    }
    for (const name of values) {
      if (!checked.has(name)) dispatch({ type: "toggle-provider", name });
    }
    dispatch({ type: "submit-providers" });
  };

  return (
    <Box flexDirection="column">
      <Text>Wrap needs at least one LLM provider configured.</Text>
      <Text> </Text>
      <Checklist
        items={items}
        checked={checked}
        width={CONTENT_WIDTH}
        onToggle={handleToggle}
        onSubmit={handleSubmit}
      />
      <Text> </Text>
      <KeyHints
        items={
          checked.size > 0
            ? [
                { combo: "Space", label: "to toggle" },
                { combo: "⏎", label: "to continue", primary: true },
              ]
            : [{ combo: "Space", label: "to toggle" }]
        }
      />
    </Box>
  );
}

function LoadingScreen() {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const id = setInterval(
      () => setFrame((f) => (f + 1) % SPINNER_FRAMES.length),
      SPINNER_INTERVAL,
    );
    return () => clearInterval(id);
  }, []);
  return <Text>{SPINNER_FRAMES[frame]} Loading models…</Text>;
}

function ApiKeyScreen({
  provider,
  draft,
  dispatch,
}: {
  provider: string;
  draft: string;
  dispatch: React.Dispatch<WizardAction>;
}) {
  const api = API_PROVIDERS[provider];
  return (
    <Box flexDirection="column">
      <Text bold>{api?.displayName ?? provider} API key</Text>
      {api?.apiKeyUrl && (
        <Text>
          Get one: <Text color="#73738c">{api.apiKeyUrl}</Text>
        </Text>
      )}
      <Text> </Text>
      <TextInput
        value={draft}
        masked
        placeholder={api?.apiKeyPlaceholder}
        onChange={(value) => dispatch({ type: "key-change", draft: value })}
        onSubmit={() => dispatch({ type: "submit-key" })}
      />
      <Text> </Text>
      <KeyHints items={[{ combo: "⏎", label: "to continue", primary: true }]} />
    </Box>
  );
}

function ModelPickerScreen({
  provider,
  models,
  cursor,
  dispatch,
}: {
  provider: string;
  models: import("../wizard/models-filter.ts").ModelEntry[];
  cursor: number;
  dispatch: React.Dispatch<WizardAction>;
}) {
  const api = API_PROVIDERS[provider];
  const [selected, setSelected] = useState(models[0]?.id ?? "");

  useInput((_input, key) => {
    if (key.return) {
      const idx = models.findIndex((m) => m.id === selected);
      if (idx >= 0) {
        if (cursor !== idx) dispatch({ type: "move-cursor", delta: idx - cursor });
        dispatch({ type: "submit-model" });
      }
    }
  });

  const options = models.map((m) => ({
    label: m.recommended ? `${m.id}  ✦ Recommended` : m.id,
    value: m.id,
  }));

  return (
    <Box flexDirection="column">
      <Text bold>{api?.displayName ?? provider} model</Text>
      <Text> </Text>
      <Select
        options={options}
        onChange={setSelected}
        visibleOptionCount={Math.min(MAX_VISIBLE_OPTIONS, models.length)}
      />
      <Text> </Text>
      <KeyHints
        items={[
          { combo: "↑↓", label: "to move" },
          { combo: "⏎", label: "to continue", primary: true },
        ]}
      />
    </Box>
  );
}

function DisclaimerScreen({ dispatch }: { dispatch: React.Dispatch<WizardAction> }) {
  useInput((_input, key) => {
    if (key.return) dispatch({ type: "accept-disclaimer" });
  });

  return (
    <Box flexDirection="column">
      <Text>
        Wrap will route your queries through the <Text bold>claude</Text> CLI instead of calling the
        Anthropic API directly. This is slower, and your prompts flow through Claude Code under its
        own terms — bring your own subscription and credentials.
      </Text>
      <Text> </Text>
      <KeyHints
        items={[
          { combo: "⏎", label: "to accept", primary: true },
          { combo: "Esc", label: "to skip this provider" },
        ]}
      />
    </Box>
  );
}

function DefaultPickerScreen({
  providers,
  cursor,
  dispatch,
}: {
  providers: string[];
  cursor: number;
  dispatch: React.Dispatch<WizardAction>;
}) {
  const [selected, setSelected] = useState(providers[0] ?? "");

  useInput((_input, key) => {
    if (key.return) {
      const idx = providers.indexOf(selected);
      if (idx >= 0) {
        if (cursor !== idx) dispatch({ type: "move-cursor", delta: idx - cursor });
        dispatch({ type: "submit-default" });
      }
    }
  });

  const options = providers.map((name) => ({
    label: API_PROVIDERS[name]?.displayName ?? CLI_PROVIDERS[name]?.displayName ?? name,
    value: name,
  }));

  return (
    <Box flexDirection="column">
      <Text bold>Which provider should be the default?</Text>
      <Text> </Text>
      <Select options={options} onChange={setSelected} />
      <Text> </Text>
      <KeyHints
        items={[
          { combo: "↑↓", label: "to move" },
          { combo: "⏎", label: "to select", primary: true },
        ]}
      />
    </Box>
  );
}
