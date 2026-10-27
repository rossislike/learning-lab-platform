import { Link, useParams } from "react-router";
import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { difficultyLabel } from "../lib/format";

export function AreaPage() {
  const { area: areaSlug = "" } = useParams();
  const area = useQuery(api.areas.getBySlug, { slug: areaSlug });
  const labs = useQuery(api.labs.listByArea, { area: areaSlug });
  const progress = useQuery(api.progress.list);

  if (area === undefined || labs === undefined) return <p className="muted">Loading…</p>;
  if (area === null) {
    return (
      <section className="notice">
        <h1>Unknown area</h1>
        <p><Link to="/">Back to areas</Link></p>
      </section>
    );
  }

  const completed = new Set(
    (progress ?? [])
      .filter((record) => record.completedAt !== undefined)
      .map((record) => String(record.labId))
  );
  const playgrounds = labs.filter((lab) => (lab.steps?.length ?? 0) === 0);
  const scenarios = labs.filter((lab) => (lab.steps?.length ?? 0) > 0);

  return (
    <section className="catalog">
      <header className="area-header">
        <h1 className="area-title">{area.title}</h1>
        <p className="area-summary">{area.summary}</p>
      </header>
      <div className="tile-grid">
        {[...playgrounds, ...scenarios].map((lab) => (
          <Link key={lab.slug} to={`/${area.slug}/${lab.slug}`} className="tile tile-dark">
            <h2>{lab.title}</h2>
            <p>{lab.summary}</p>
            <span className="tile-foot">
              <span className="tile-meta">
                {lab.kind === "react" ? "React" : "Terminal"} · {difficultyLabel(lab.difficultyLabel ?? lab.difficulty)}
                {lab.steps?.length ? ` · ${lab.steps.length} steps` : " · playground"}
              </span>
              {completed.has(String(lab._id)) ? <span className="check" title="Completed">✓</span> : null}
            </span>
          </Link>
        ))}
      </div>
    </section>
  );
}
