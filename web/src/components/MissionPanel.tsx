import { useState } from 'react';
import { MissionGraph } from './MissionGraph';
import type { AnalystResult, Artifact, MissionDetail, Task, ToolCall } from '../types';
import { ActivityFeed } from './ActivityFeed';
import { Confidence, Fact, Block, Pill, clock, duration } from './primitives';

function isAnalystResult(value: unknown): value is AnalystResult {
  return (
    typeof value === 'object' &&
    value !== null &&
    'findings' in value &&
    Array.isArray((value as AnalystResult).findings)
  );
}

/** One row of the pipeline: what ran, on what, and what it produced. */
function TaskRow({
  task,
  model,
  open,
  onToggle,
}: {
  task: Task;
  model: string | undefined;
  open: boolean;
  onToggle: () => void;
}): React.JSX.Element {
  const expandable = task.output !== null || task.error !== null;

  return (
    <li className={`task task--${task.status}`}>
      <button
        type="button"
        className="task__head"
        onClick={() => expandable && onToggle()}
        aria-expanded={open}
        disabled={!expandable}
      >
        <span className="task__marker" aria-hidden="true" />
        <span className="task__title">{task.title || task.agentId}</span>
        <span className="task__side">
          <span>{task.agentId}</span>
          {model && <span>{model}</span>}
          <span>{duration(task.startedAt, task.completedAt)}</span>
        </span>
        <Pill status={task.status} />
      </button>

      {open && (
        <div className="task__body">
          {task.instruction && (
            <p className="task__instruction">
              <strong>Brief:</strong> {task.instruction}
            </p>
          )}
          {task.error && <p className="error">{task.error}</p>}
          {isAnalystResult(task.output) ? (
            <>
              <p className="task__headline">{task.output.headline}</p>
              <ul className="findings">
                {task.output.findings.map((finding, i) => (
                  <li key={i}>
                    <h4>{finding.point}</h4>
                    <p>{finding.detail}</p>
                  </li>
                ))}
              </ul>
              <Confidence level={task.output.confidence} />
            </>
          ) : (
            task.output !== null && (
              <pre className="task__raw">{JSON.stringify(task.output, null, 2)}</pre>
            )
          )}
        </div>
      )}
    </li>
  );
}


/**
 * The files a mission produced.
 *
 * Derived from what the write tool actually did, not from what an agent said it
 * made — a model can report a file it never wrote, and a mission that claims an
 * artifact it does not have is worse than one that admits it produced nothing.
 * Failed writes are excluded for the same reason.
 */
const PREVIEWABLE = new Set(['svg', 'html', 'md', 'json', 'csv', 'txt']);

function artifactsFrom(toolCalls: ToolCall[]): Artifact[] {
  const seen = new Map<string, Artifact>();
  for (const call of toolCalls) {
    if (call.toolId !== 'workspace.write' || call.error) continue;
    const path = call.input?.path;
    if (typeof path !== 'string') continue;
    const ext = path.split('.').pop()?.toLowerCase() ?? '';
    // A path written twice is one artifact; the later write is the final state.
    seen.set(path, { path, previewable: PREVIEWABLE.has(ext) });
  }
  return [...seen.values()];
}

function ArtifactView({ artifact }: { artifact: Artifact }): React.JSX.Element {
  const href = `/api/artifacts?path=${encodeURIComponent(artifact.path)}`;
  const isImage = artifact.path.toLowerCase().endsWith('.svg');

  return (
    <li className="artifact">
      <div className="artifact__head">
        <span className="artifact__name">{artifact.path}</span>
        <a className="link" href={href} target="_blank" rel="noreferrer">
          open
        </a>
      </div>
      {isImage && (
        // Rendered through <img> rather than inlined. An SVG written by a model
        // is untrusted markup, and a browser will not run scripts inside an
        // image — inlining it would hand that markup the page's origin.
        <div className="artifact__preview">
          {/* Not lazy. A mission produces a handful of files at most, so lazy
              loading buys nothing — and it cost correctness: below the fold in
              a scrolling panel the image never entered the viewport, never
              loaded, and collapsed to a 24px placeholder. */}
          <img src={href} alt={artifact.path} />
        </div>
      )}
    </li>
  );
}

/** Plain wording for what did not finish, so the count is not left to be inferred. */
function describeShortfall(failed: number, skipped: number): string {
  const parts = [
    failed > 0 ? `${failed} step${failed === 1 ? '' : 's'} failed` : '',
    skipped > 0 ? `${skipped} was skipped` : '',
  ].filter(Boolean);
  return `This mission finished, but ${parts.join(' and ')}.`;
}

export function MissionPanel({
  detail,
  onRemember,
}: {
  detail: MissionDetail;
  onRemember: (content: string) => void;
}): React.JSX.Element {
  const { mission, tasks, events, modelCalls, toolCalls } = detail;
  const artifacts = artifactsFrom(toolCalls);
  const modelByTask = new Map(modelCalls.map((c) => [c.taskId, `${c.providerId}/${c.modelId}`]));
  const tokens = modelCalls.reduce(
    (acc, c) => ({ in: acc.in + c.tokensIn, out: acc.out + c.tokensOut }),
    { in: 0, out: 0 },
  );
  const result = mission.result;
  const [openTask, setOpenTask] = useState<string | null>(null);

  /**
   * A mission finishes even when steps inside it did not.
   *
   * Synthesis runs on partial results by design — losing one analyst of three
   * should not throw away the other two. But the mission then reports
   * `completed`, and the shortfall was visible only as "3/4" among eight grey
   * facts. A mission that was asked for something, lost the step that produced
   * it, and returned a confident recommendation anyway reads as a success.
   */
  const failed = tasks.filter((t) => t.status === 'failed');
  const skipped = tasks.filter((t) => t.status === 'skipped');
  const shortfall = failed.length + skipped.length;
  const partial = mission.status === 'completed' && shortfall > 0;

  const toggle = (id: string): void => setOpenTask((current) => (current === id ? null : id));

  return (
    <>
      <Block
        label="Mission"
        actions={
          <>
            {partial && <span className="pill pill--partial">partial</span>}
            <Pill status={mission.status} />
          </>
        }
      >
        <p className="objective">{mission.objective}</p>
        {mission.plan && <p className="plan-summary">{mission.plan.summary}</p>}
        <div className="facts">
          <Fact label="Tasks">
            <span className={partial ? 'fact__value--warn' : undefined}>
              {tasks.filter((t) => t.status === 'completed').length}/{tasks.length}
            </span>
          </Fact>
          <Fact label="Started">{clock(mission.startedAt)}</Fact>
          <Fact label="Finished">{clock(mission.completedAt)}</Fact>
          <Fact label="Elapsed">{duration(mission.startedAt, mission.completedAt)}</Fact>
          <Fact label="Tokens">
            {tokens.in} in / {tokens.out} out
          </Fact>
          <Fact label="Cost">
            <span className="cost-free">£0.00</span>
          </Fact>
          <Fact label="Effort">{mission.effort}</Fact>
          <Fact label="Model choice">
            {mission.modelPref === 'auto' ? 'auto' : mission.modelPref}
          </Fact>
        </div>
        {mission.error && <p className="error">{mission.error}</p>}
        {partial && (
          <p className="warn">
            {describeShortfall(failed.length, skipped.length)} Anything below was
            synthesised from the steps that did finish, so treat it as partial evidence —
            and if this mission was meant to produce a file, check the artifacts.
          </p>
        )}
      </Block>

      <Block label="Connections">
        <MissionGraph tasks={tasks} selectedId={openTask} onSelect={toggle} />
      </Block>

      <Block label="Pipeline">
        <ol className="tasks">
          {tasks.map((task) => (
            <TaskRow
              key={task.id}
              task={task}
              model={modelByTask.get(task.id)}
              open={openTask === task.id}
              onToggle={() => toggle(task.id)}
            />
          ))}
        </ol>
        {tasks.some((t) => t.output !== null) && (
          <p className="muted">Select a step to see what it produced.</p>
        )}
      </Block>

      {artifacts.length > 0 && (
        <Block label="Artifacts">
          <ul className="artifacts">
            {artifacts.map((artifact) => (
              <ArtifactView key={artifact.path} artifact={artifact} />
            ))}
          </ul>
        </Block>
      )}

      {result && (
        <Block
          label="Recommendation"
          actions={<Confidence level={result.confidence} />}
        >
          <p className="answer">{result.recommendation}</p>

          <h3 className="subhead">Key points</h3>
          <ul className="bullets">
            {result.keyPoints.map((point, i) => (
              <li key={i}>
                <span>{point}</span>
                <button
                  type="button"
                  className="link"
                  onClick={() => onRemember(point)}
                  title="Keep this in project memory"
                >
                  remember
                </button>
              </li>
            ))}
          </ul>

          {result.uncertainties.length > 0 && (
            <>
              <h3 className="subhead">Uncertainties</h3>
              <ul className="bullets bullets--muted">
                {result.uncertainties.map((item, i) => (
                  <li key={i}>{item}</li>
                ))}
              </ul>
            </>
          )}

          <p className="caveat">
            These findings have not been independently verified. Critic agents that check claims
            against a second model arrive in a later milestone.
          </p>
        </Block>
      )}

      <Block label="Activity">
        <ActivityFeed events={events} />
      </Block>
    </>
  );
}
