import { Select } from "@inkjs/ui";
import { Box, Text, useInput, useWindowSize } from "ink";
import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { ProviderEntry } from "../config/config.ts";
import { updateConfig } from "../config/store.ts";
import { SPINNER_FRAMES, SPINNER_INTERVAL } from "../core/spinner.ts";
import { getTheme, themeHex } from "../core/theme.ts";
import { API_PROVIDERS, CLI_PROVIDERS } from "../llm/providers/registry.ts";
import type { WizardResult } from "../session/dialog-host.ts";
import type { ModelsDevData } from "../wizard/models-filter.ts";
import { initWizardState, reduce, type WizardAction } from "../wizard/state.ts";
import { Checklist, type ChecklistItem } from "./checklist.tsx";
import { Dialog, dialogInnerWidth } from "./dialog.tsx";
import { NerdIconsSection } from "./nerd-icons-section.tsx";
import { TextInput } from "./text-input.tsx";
import {
  getWizardBadge,
  getWizardStops,
  KeyHints,
  WIZARD_CONTENT_WIDTH,
} from "./wizard-chrome.tsx";

const MAX_VISIBLE_OPTIONS = 8;

// ── Providers Section ──────────────────────────────────────────────

export type ProvidersResult = {
  entries: Record<string, ProviderEntry>;
  defaultProvider: string;
};

export type ProvidersSectionProps = {
  fetchModels: () => Promise<ModelsDevData>;
  probeCliBinaries: () => Record<string, boolean>;
  onDone: (result: ProvidersResult) => void;
  onCancel: () => void;
};

export function ProvidersSection({
  fetchModels,
  probeCliBinaries,
  onDone,
  onCancel,
}: ProvidersSectionProps) {
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
      onDone({ entries: state.builtEntries, defaultProvider: state.defaultProvider as string });
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
  const { columns: termCols } = useWindowSize();
  const innerWidth = dialogInnerWidth(termCols, WIZARD_CONTENT_WIDTH);
  let bottomStatus: string | undefined;
  if (screen.tag === "loading-models") {
    bottomStatus = "Loading models list…";
  }

  return (
    <Dialog
      gradientStops={getWizardStops()}
      badge={getWizardBadge()}
      bottomStatus={bottomStatus}
      naturalContentWidth={WIZARD_CONTENT_WIDTH}
    >
      {screen.tag === "selecting-providers" && (
        <ProviderSelectionScreen
          checked={screen.checked}
          cliAvailable={cliAvailable}
          contentWidth={innerWidth}
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

// ── Orchestrator ───────────────────────────────────────────────────

export type WizardCallbacks = {
  fetchModels: () => Promise<ModelsDevData>;
  probeCliBinaries: () => Record<string, boolean>;
  onDone: (result: WizardResult) => void;
  onCancel: () => void;
};

type WizardSection = "nerd-icons" | "providers";

export function ConfigWizardDialog({
  fetchModels,
  probeCliBinaries,
  onDone,
  onCancel,
}: WizardCallbacks) {
  const [section, setSection] = useState<WizardSection>("nerd-icons");
  const nerdFontsRef = useRef<boolean | undefined>(undefined);

  if (section === "nerd-icons") {
    return (
      <NerdIconsSection
        onDone={(result) => {
          nerdFontsRef.current = result.nerdFonts;
          updateConfig({ nerdFonts: result.nerdFonts });
          setSection("providers");
        }}
        onCancel={onCancel}
      />
    );
  }

  return (
    <ProvidersSection
      fetchModels={fetchModels}
      probeCliBinaries={probeCliBinaries}
      onDone={(result) => onDone({ ...result, nerdFonts: nerdFontsRef.current })}
      onCancel={onCancel}
    />
  );
}

// ── Provider Screens ───────────────────────────────────────────────

function ProviderSelectionScreen({
  checked,
  cliAvailable,
  contentWidth,
  dispatch,
}: {
  checked: Set<string>;
  cliAvailable: Record<string, boolean>;
  contentWidth: number;
  dispatch: React.Dispatch<WizardAction>;
}) {
  const hasAnyCli = Object.values(cliAvailable).some(Boolean);

  const items = useMemo(() => {
    const list: ChecklistItem[] = [{ type: "header", label: "Select API Provider(s)" }];
    for (const [name, p] of Object.entries(API_PROVIDERS)) {
      list.push({ type: "option", label: p.displayName, value: name, icon: p.nerdIcon });
    }
    if (hasAnyCli) {
      list.push({ type: "header", label: "Use your coding agent's subscription" });
      for (const [name, p] of Object.entries(CLI_PROVIDERS)) {
        if (cliAvailable[name]) {
          list.push({ type: "option", label: p.displayName, value: name, icon: p.nerdIcon });
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
        width={contentWidth}
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
          Get one: <Text color={themeHex(getTheme().text.muted)}>{api.apiKeyUrl}</Text>
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
