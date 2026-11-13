import React, { useMemo, useState } from 'react';
import { Alert } from 'react-native';
import {
  Button, Form, HStack, Image, LabeledContent, Menu, Picker, Section, Spacer, Text, TextField, Toggle,
  useNativeState,
} from '@expo/ui/swift-ui';
import {
  buttonStyle, foregroundStyle, keyboardType, lineLimit, multilineTextAlignment, pickerStyle,
  scrollContentBackground, tag,
} from '@expo/ui/swift-ui/modifiers';

// ── Wire format (mirrors LogicGraph in ReactUnity's CreateScreen) ───────────
export interface LogicGuard { id: string; type: string; negate: boolean; params: Record<string, string> }
export interface LogicStep { id: string; type: string; params: Record<string, string>; guards: LogicGuard[]; enabled: boolean }
export interface LogicWorkflow {
  id: string; name: string; color: string; enabled: boolean;
  event: { type: string; params: Record<string, string> };
  guards: LogicGuard[]; steps: LogicStep[];
}
export interface LogicVariable { id: string; name: string; source: 'asset' | 'part' | 'interface'; target: string; owner?: string }
export interface LogicGraph { workflows: LogicWorkflow[]; variables: LogicVariable[] }

interface Field {
  key: string; label: string; placeholder?: string;
  kind?: 'text' | 'select' | 'toggle' | 'vector'; options?: string[]; hint?: string;
}
interface EventDef { type: string; label: string; icon: string; category: string; fields: Field[]; help: string }
interface GuardDef { type: string; label: string; icon: string; fields: Field[]; help: string }
interface ActionDef { type: string; label: string; icon: string; group: string; category: string; template: string; fields: Field[]; help: string }
export interface LogicCatalog {
  events: EventDef[]; guards: GuardDef[]; actions: ActionDef[];
  groups: { name: string; accent: string }[]; colors: string[];
}

/** Where the panel is in its drill-down (the panel header shows `title`). */
export type LogicPage =
  | { kind: 'list' }
  | { kind: 'workflow'; wf: string }
  | { kind: 'pickEvent'; wf: string | null }
  | { kind: 'pickGuard'; wf: string }
  | { kind: 'pickNode'; wf: string }
  | { kind: 'step'; wf: string; step: string }
  | { kind: 'guard'; wf: string; guard: string }
  | { kind: 'variable'; variable: string };

const GROUP_SYMBOL: Record<string, string> = {
  System: 'play.circle.fill', Action: 'bolt.fill', Condition: 'questionmark.diamond.fill',
  Flow: 'arrow.triangle.branch', Logic: 'function',
};
const COLOR_NAMES: Record<string, string> = {
  '#5B9CFF': 'Blue', '#34d399': 'Green', '#fcd34d': 'Yellow', '#f87171': 'Red',
  '#c084fc': 'Purple', '#22d3ee': 'Cyan', '#fb923c': 'Orange', '#94a3b8': 'Gray',
};

function newId(prefix: string) {
  return `${prefix}_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e4).toString(36)}`;
}
function blank(fields: Field[]) {
  const p: Record<string, string> = {};
  fields.forEach(f => { p[f.key] = ''; });
  return p;
}
function show(v: string | undefined, f: Field) {
  if (!v) return f.label;
  if (f.kind === 'vector') return `(${v.split(',').map(x => x.trim() || '0').join(', ')})`;
  if (f.kind === 'toggle') return v === 'true' ? `${f.label}: on` : `${f.label}: off`;
  return v;
}
/** The node's sentence with its slots filled ("Force Player to move in …"). */
function sentence(def: ActionDef | undefined, params: Record<string, string>) {
  if (!def) return '';
  return def.template.replace(/\{(\w+)\}/g, (_m, k) => {
    const f = def.fields.find(x => x.key === k);
    return f ? show(params[k], f) : String(params[k] ?? k);
  });
}
const secondary = foregroundStyle({ type: 'hierarchical', style: 'secondary' });

export function logicPageTitle(page: LogicPage, graph: LogicGraph, cat: LogicCatalog | null): string {
  switch (page.kind) {
    case 'list': return 'Workflow';
    case 'workflow': {
      const wf = graph.workflows.find(w => w.id === page.wf);
      return wf ? (wf.name.trim() || cat?.events.find(e => e.type === wf.event.type)?.label || 'Workflow') : 'Workflow';
    }
    case 'pickEvent': return 'When…';
    case 'pickGuard': return 'Only When…';
    case 'pickNode': return 'Add Step';
    case 'step': {
      const wf = graph.workflows.find(w => w.id === page.wf);
      const st = wf?.steps.find(s => s.id === page.step);
      return cat?.actions.find(a => a.type === st?.type)?.label ?? 'Step';
    }
    case 'guard': return 'Condition';
    case 'variable': return 'Variable';
  }
}

// Native Custom Logic editor (phase 4) — the same Bubble-style workflows as
// ReactUnity's CustomLogicPanel, as a Settings-style drill-down. ReactUnity
// owns the graph (and mirrors it to Unity); every edit here sends the whole
// updated graph back and the echo re-renders the panel.
export function LogicEditor({ graph, catalog, page, push, pop, onChange, onPick }: {
  graph: LogicGraph;
  catalog: LogicCatalog | null;
  page: LogicPage;
  push: (p: LogicPage) => void;
  pop: () => void;
  onChange: (g: LogicGraph) => void;
  onPick: (variableId: string) => void;
}) {
  const [query, setQuery] = useState('');
  const cat = catalog;
  const ev = (t: string) => cat?.events.find(e => e.type === t);
  const gd = (t: string) => cat?.guards.find(g => g.type === t);
  const ac = (t: string) => cat?.actions.find(a => a.type === t);

  const setWf = (id: string, fn: (w: LogicWorkflow) => LogicWorkflow) =>
    onChange({ ...graph, workflows: graph.workflows.map(w => (w.id === id ? fn(w) : w)) });

  if (!cat) {
    return <Form modifiers={[scrollContentBackground('hidden')]}><Section><Text>Loading…</Text></Section></Form>;
  }

  // ── Workflows + variables ──
  if (page.kind === 'list') {
    return (
      <Form modifiers={[scrollContentBackground('hidden')]}>
        <Section title="Workflows" footer={<Text>Each workflow runs its steps when its event happens.</Text>}>
          {graph.workflows.map(w => (
            <Button key={w.id} onPress={() => push({ kind: 'workflow', wf: w.id })} modifiers={[buttonStyle('plain')]}>
              <HStack spacing={10}>
                <Image systemName="circle.fill" size={10} color={w.color} />
                <Text modifiers={[lineLimit(1)]}>{w.name.trim() || ev(w.event.type)?.label || 'Workflow'}</Text>
                <Spacer />
                {!w.enabled && <Text modifiers={[secondary]}>Off</Text>}
                <Text modifiers={[secondary]}>{`${Math.max(0, w.steps.length - 1)} steps`}</Text>
                <Image systemName="chevron.right" size={12} color="gray" />
              </HStack>
            </Button>
          ))}
          <Button label="Add Workflow" systemImage="plus.circle.fill" onPress={() => push({ kind: 'pickEvent', wf: null })} />
        </Section>
        <Section title="Variables" footer={<Text>Name objects so steps can refer to them as {'{{name}}'}.</Text>}>
          {graph.variables.map(v => (
            <Button key={v.id} onPress={() => push({ kind: 'variable', variable: v.id })} modifiers={[buttonStyle('plain')]}>
              <HStack spacing={8}>
                <Text>{`{{${v.name}}}`}</Text>
                <Spacer />
                <Text modifiers={[secondary, lineLimit(1)]}>{v.target ? v.target.split('/').pop()!.slice(0, 18) : 'Not set'}</Text>
                <Image systemName="chevron.right" size={12} color="gray" />
              </HStack>
            </Button>
          ))}
          <Button
            label="Add Variable"
            systemImage="plus.circle.fill"
            onPress={() => Alert.prompt('New variable', 'Give an object a name, then pick it in the scene.', name => {
              const n = (name ?? '').trim().replace(/[{}]/g, '');
              if (!n) return;
              const v: LogicVariable = { id: newId('var'), name: n, source: 'asset', target: '' };
              onChange({ ...graph, variables: [...graph.variables, v] });
            }, 'plain-text', '', 'default', { userInterfaceStyle: 'dark' })}
          />
        </Section>
      </Form>
    );
  }

  // ── Event / condition / step pickers ──
  if (page.kind === 'pickEvent' || page.kind === 'pickGuard' || page.kind === 'pickNode') {
    const q = query.trim().toLowerCase();
    const match = (label: string) => !q || label.toLowerCase().includes(q);
    const done = () => { setQuery(''); pop(); };
    let body: React.ReactNode;
    if (page.kind === 'pickEvent') {
      const cats = [...new Set(cat.events.map(e => e.category))];
      body = cats.map(c => {
        const items = cat.events.filter(e => e.category === c && match(e.label));
        if (!items.length) return null;
        return (
          <Section key={c} title={c}>
            {items.map(e => (
              <Button key={e.type} label={e.label} onPress={() => {
                if (page.wf) {
                  setWf(page.wf, w => ({ ...w, event: { type: e.type, params: blank(e.fields) } }));
                  done();
                } else {
                  const wf: LogicWorkflow = {
                    id: newId('wf'), name: '', color: cat.colors[graph.workflows.length % cat.colors.length] ?? '#5B9CFF',
                    enabled: true, event: { type: e.type, params: blank(e.fields) }, guards: [],
                    steps: [{ id: newId('step'), type: 'execute', params: {}, guards: [], enabled: true }],
                  };
                  onChange({ ...graph, workflows: [...graph.workflows, wf] });
                  setQuery('');
                  pop();
                  push({ kind: 'workflow', wf: wf.id });
                }
              }} />
            ))}
          </Section>
        );
      });
    } else if (page.kind === 'pickGuard') {
      body = (
        <Section title="Conditions">
          {cat.guards.filter(g => match(g.label)).map(g => (
            <Button key={g.type} label={g.label} onPress={() => {
              setWf(page.wf, w => ({ ...w, guards: [...w.guards, { id: newId('guard'), type: g.type, negate: false, params: blank(g.fields) }] }));
              done();
            }} />
          ))}
        </Section>
      );
    } else {
      body = cat.groups.map(gr => {
        const items = cat.actions.filter(a => a.group === gr.name && a.type !== 'execute' && match(a.label));
        if (!items.length) return null;
        return (
          <Section key={gr.name} title={gr.name}>
            {items.map(a => (
              <Button key={a.type} onPress={() => {
                const st: LogicStep = { id: newId('step'), type: a.type, params: blank(a.fields), guards: [], enabled: true };
                setWf(page.wf, w => ({ ...w, steps: [...w.steps, st] }));
                setQuery('');
                pop();
                push({ kind: 'step', wf: page.wf, step: st.id });
              }} modifiers={[buttonStyle('plain')]}>
                <HStack spacing={8}>
                  <Image systemName={(GROUP_SYMBOL[gr.name] ?? 'circle') as any} size={13} color={gr.accent} />
                  <Text>{a.label}</Text>
                  <Spacer />
                  <Text modifiers={[secondary]}>{a.category}</Text>
                </HStack>
              </Button>
            ))}
          </Section>
        );
      });
    }
    return (
      <Form modifiers={[scrollContentBackground('hidden')]}>
        <Section>
          <SearchField onChange={setQuery} />
        </Section>
        {body}
      </Form>
    );
  }

  // ── Variable ──
  if (page.kind === 'variable') {
    const v = graph.variables.find(x => x.id === page.variable);
    if (!v) return null;
    const setVar = (patch: Partial<LogicVariable>) =>
      onChange({ ...graph, variables: graph.variables.map(x => (x.id === v.id ? { ...x, ...patch } : x)) });
    return (
      <Form modifiers={[scrollContentBackground('hidden')]}>
        <Section title="Name">
          <PlainField key={v.id} initial={v.name} placeholder="Name" onChange={t => setVar({ name: t.replace(/[{}]/g, '') })} />
        </Section>
        <Section title="Refers to" footer={<Text>Pick closes the panel — tap the object in the scene.</Text>}>
          <LabeledContent label="Object"><Text modifiers={[secondary, lineLimit(1)]}>{v.target || 'Not set'}</Text></LabeledContent>
          <Button label="Pick in Scene" systemImage="hand.tap" onPress={() => onPick(v.id)} />
        </Section>
        <Section>
          <Button label="Delete Variable" role="destructive" onPress={() => {
            onChange({ ...graph, variables: graph.variables.filter(x => x.id !== v.id) });
            pop();
          }} />
        </Section>
      </Form>
    );
  }

  const wf = graph.workflows.find(w => w.id === page.wf);
  if (!wf) return null;

  // ── Workflow ──
  if (page.kind === 'workflow') {
    const e = ev(wf.event.type);
    return (
      <Form modifiers={[scrollContentBackground('hidden')]}>
        <Section title="When" footer={e?.help ? <Text>{e.help}</Text> : undefined}>
          <Button onPress={() => push({ kind: 'pickEvent', wf: wf.id })} modifiers={[buttonStyle('plain')]}>
            <HStack spacing={8}>
              <Image systemName="flag.fill" size={13} color="#FF9F0A" />
              <Text>{e?.label ?? wf.event.type}</Text>
              <Spacer />
              <Image systemName="chevron.right" size={12} color="gray" />
            </HStack>
          </Button>
          <Fields
            id={`${wf.id}-event`}
            fields={e?.fields ?? []}
            params={wf.event.params}
            variables={graph.variables}
            onChange={params => setWf(wf.id, w => ({ ...w, event: { ...w.event, params } }))}
          />
        </Section>

        <Section title="Only When">
          {wf.guards.map(g => (
            <Button key={g.id} onPress={() => push({ kind: 'guard', wf: wf.id, guard: g.id })} modifiers={[buttonStyle('plain')]}>
              <HStack spacing={8}>
                <Text>{`${g.negate ? 'Not: ' : ''}${gd(g.type)?.label ?? g.type}`}</Text>
                <Spacer />
                <Image systemName="chevron.right" size={12} color="gray" />
              </HStack>
            </Button>
          ))}
          <Button label="Add Condition" systemImage="plus.circle" onPress={() => push({ kind: 'pickGuard', wf: wf.id })} />
        </Section>

        <Section title="Steps">
          {wf.steps.map((st, i) => {
            const a = ac(st.type);
            return (
              <Button key={st.id} onPress={() => push({ kind: 'step', wf: wf.id, step: st.id })} modifiers={[buttonStyle('plain')]}>
                <HStack spacing={8}>
                  <Image systemName={(GROUP_SYMBOL[a?.group ?? ''] ?? 'circle') as any} size={13}
                    color={cat.groups.find(g => g.name === a?.group)?.accent ?? '#999'} />
                  <Text modifiers={[lineLimit(2), ...(st.enabled ? [] : [secondary])]}>
                    {i === 0 ? 'Execute' : `${i}. ${sentence(a, st.params) || a?.label || st.type}`}
                  </Text>
                  <Spacer />
                  <Image systemName="chevron.right" size={12} color="gray" />
                </HStack>
              </Button>
            );
          })}
          <Button label="Add Step" systemImage="plus.circle.fill" onPress={() => push({ kind: 'pickNode', wf: wf.id })} />
        </Section>

        <Section title="Workflow">
          <PlainField key={`${wf.id}-name`} initial={wf.name} placeholder="Name (optional)" onChange={t => setWf(wf.id, w => ({ ...w, name: t }))} />
          <Picker
            label="Color"
            selection={wf.color}
            onSelectionChange={(c: string) => setWf(wf.id, w => ({ ...w, color: c }))}
            modifiers={[pickerStyle('menu')]}
          >
            {cat.colors.map(c => <Text key={c} modifiers={[tag(c)]}>{COLOR_NAMES[c] ?? c}</Text>)}
          </Picker>
          <Toggle label="Enabled" isOn={wf.enabled} onIsOnChange={on => setWf(wf.id, w => ({ ...w, enabled: on }))} />
          <Button label="Delete Workflow" role="destructive" onPress={() => {
            onChange({ ...graph, workflows: graph.workflows.filter(w => w.id !== wf.id) });
            pop();
          }} />
        </Section>
      </Form>
    );
  }

  // ── Step ──
  if (page.kind === 'step') {
    const idx = wf.steps.findIndex(s => s.id === page.step);
    const st = wf.steps[idx];
    if (!st) return null;
    const a = ac(st.type);
    const isRoot = st.type === 'execute';
    const setStep = (patch: Partial<LogicStep>) =>
      setWf(wf.id, w => ({ ...w, steps: w.steps.map(s => (s.id === st.id ? { ...s, ...patch } : s)) }));
    const move = (d: -1 | 1) => setWf(wf.id, w => {
      const steps = [...w.steps];
      const j = idx + d;
      if (j < 1 || j >= steps.length) return w;   // the Execute root stays first
      [steps[idx], steps[j]] = [steps[j], steps[idx]];
      return { ...w, steps };
    });
    return (
      <Form modifiers={[scrollContentBackground('hidden')]}>
        <Section footer={a?.help ? <Text>{a.help}</Text> : undefined}>
          <Fields id={st.id} fields={a?.fields ?? []} params={st.params} variables={graph.variables}
            onChange={params => setStep({ params })} />
          {!isRoot && <Toggle label="Enabled" isOn={st.enabled} onIsOnChange={on => setStep({ enabled: on })} />}
        </Section>
        {!isRoot && (
          <Section>
            <Button label="Move Up" systemImage="arrow.up" onPress={() => move(-1)} />
            <Button label="Move Down" systemImage="arrow.down" onPress={() => move(1)} />
            <Button label="Delete Step" role="destructive" onPress={() => {
              setWf(wf.id, w => ({ ...w, steps: w.steps.filter(s => s.id !== st.id) }));
              pop();
            }} />
          </Section>
        )}
      </Form>
    );
  }

  // ── Condition ("Only when") ──
  const g = wf.guards.find(x => x.id === page.guard);
  if (!g) return null;
  const def = gd(g.type);
  const setGuard = (patch: Partial<LogicGuard>) =>
    setWf(wf.id, w => ({ ...w, guards: w.guards.map(x => (x.id === g.id ? { ...x, ...patch } : x)) }));
  return (
    <Form modifiers={[scrollContentBackground('hidden')]}>
      <Section title={def?.label} footer={def?.help ? <Text>{def.help}</Text> : undefined}>
        <Toggle label="Is not" isOn={g.negate} onIsOnChange={on => setGuard({ negate: on })} />
        <Fields id={g.id} fields={def?.fields ?? []} params={g.params} variables={graph.variables}
          onChange={params => setGuard({ params })} />
      </Section>
      <Section>
        <Button label="Delete Condition" role="destructive" onPress={() => {
          setWf(wf.id, w => ({ ...w, guards: w.guards.filter(x => x.id !== g.id) }));
          pop();
        }} />
      </Section>
    </Form>
  );
}

// One editor row per catalog field. Text fields can take a {{variable}} from
// the menu beside them; vectors edit as X / Y / Z.
function Fields({ id, fields, params, variables, onChange }: {
  id: string; fields: Field[]; params: Record<string, string>; variables: LogicVariable[];
  onChange: (p: Record<string, string>) => void;
}) {
  // Bumped when a variable is inserted so the uncontrolled field re-seeds.
  const [gen, setGen] = useState(0);
  const set = (k: string, v: string) => onChange({ ...params, [k]: v });
  return (
    <>
      {fields.map(f => {
        const v = params[f.key] ?? '';
        if (f.kind === 'toggle') {
          return <Toggle key={f.key} label={f.label} isOn={v === 'true'} onIsOnChange={on => set(f.key, on ? 'true' : 'false')} />;
        }
        if (f.kind === 'select' && f.options?.length) {
          return (
            <Picker key={f.key} label={f.label} selection={v || f.options[0]}
              onSelectionChange={(x: string) => set(f.key, x)} modifiers={[pickerStyle('menu')]}>
              {f.options.map(o => <Text key={o} modifiers={[tag(o)]}>{o}</Text>)}
            </Picker>
          );
        }
        if (f.kind === 'vector') {
          const parts = (v || ',,').split(',');
          const setAxis = (i: number, x: string) => {
            const next = [0, 1, 2].map(j => (j === i ? x : (parts[j] ?? '').trim()));
            set(f.key, next.join(','));
          };
          return (
            <LabeledContent key={f.key} label={f.label}>
              <HStack spacing={6}>
                {[0, 1, 2].map(i => (
                  <AxisField key={`${id}-${f.key}-${i}-${gen}`} axis={'XYZ'[i]} initial={(parts[i] ?? '').trim()} onChange={x => setAxis(i, x)} />
                ))}
              </HStack>
            </LabeledContent>
          );
        }
        return (
          <LabeledContent key={f.key} label={f.label}>
            <HStack spacing={6}>
              <PlainField key={`${id}-${f.key}-${gen}`} initial={v} placeholder={f.placeholder ?? ''} trailing
                onChange={x => set(f.key, x)} />
              {variables.length > 0 && (
                <Menu label="Insert variable" systemImage="link">
                  {variables.map(vr => (
                    <Button key={vr.id} label={`{{${vr.name}}}`} onPress={() => { set(f.key, `{{${vr.name}}}`); setGen(n => n + 1); }} />
                  ))}
                </Menu>
              )}
            </HStack>
          </LabeledContent>
        );
      })}
    </>
  );
}

function PlainField({ initial, placeholder, onChange, trailing }: {
  initial: string; placeholder: string; onChange: (v: string) => void; trailing?: boolean;
}) {
  const text = useNativeState(initial);
  return (
    <TextField
      text={text}
      placeholder={placeholder}
      onTextChange={onChange}
      modifiers={trailing ? [multilineTextAlignment('trailing')] : []}
    />
  );
}

function AxisField({ axis, initial, onChange }: { axis: string; initial: string; onChange: (v: string) => void }) {
  const text = useNativeState(initial);
  return (
    <TextField
      text={text}
      placeholder={axis}
      onTextChange={onChange}
      modifiers={[keyboardType('numbers-and-punctuation'), multilineTextAlignment('center')]}
    />
  );
}

function SearchField({ onChange }: { onChange: (q: string) => void }) {
  const text = useNativeState('');
  return (
    <HStack spacing={8}>
      <Image systemName="magnifyingglass" size={14} color="gray" />
      <TextField text={text} placeholder="Search" onTextChange={onChange} />
    </HStack>
  );
}

/** Reset helper for callers that keep a page stack. */
export function useLogicPages() {
  const [stack, setStack] = useState<LogicPage[]>([{ kind: 'list' }]);
  return useMemo(() => ({
    page: stack[stack.length - 1],
    depth: stack.length,
    push: (p: LogicPage) => setStack(s => [...s, p]),
    pop: () => setStack(s => (s.length > 1 ? s.slice(0, -1) : s)),
    reset: () => setStack([{ kind: 'list' }]),
  }), [stack]);
}
