import { useMemo } from "react";
import { Link, useSearchParams } from "react-router";
import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";

export function AreasPage() {
  const areas = useQuery(api.areas.list);
  const labs = useQuery(api.labs.list);
  // The search lives in ?q= so it survives reloads and the Playgrounds tile can link to it.
  const [params, setParams] = useSearchParams();
  const search = params.get("q") ?? "";
  const setSearch = (value: string) => setParams(value ? { q: value } : {}, { replace: true });

  const counts = useMemo(() => {
    const map = new Map<string, number>();
    for (const lab of labs ?? []) map.set(lab.area ?? "", (map.get(lab.area ?? "") ?? 0) + 1);
    return map;
  }, [labs]);

  const query = search.trim().toLowerCase();
  const matchingLabs = query
    ? (labs ?? []).filter((lab) => `${lab.title} ${lab.summary} ${lab.tags.join(" ")} ${lab.area}`.toLowerCase().includes(query))
    : [];
  const visibleAreas = (areas ?? []).filter(
    (area) => !query || area.title.toLowerCase().includes(query) || matchingLabs.some((lab) => lab.area === area.slug)
  );

  return (
    <section className="catalog">
      <input
        className="search"
        type="search"
        placeholder="Search…"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        aria-label="Search scenarios"
      />
      {areas === undefined ? (
        <p className="muted">Loading areas…</p>
      ) : areas.length === 0 ? (
        <p className="muted">No areas yet. Seed the scenarios from the Admin page.</p>
      ) : (
        <div className="tile-grid">
          <Link to="/?q=playground" className="tile tile-dark">
            <h2>Playgrounds</h2>
            <p>Empty environments for each area. No steps, no checks.</p>
          </Link>
          {visibleAreas.map((area) => (
            <Link key={area.slug} to={`/${area.slug}`} className="tile">
              <h2>{area.title}</h2>
              <p>{area.summary}</p>
              <span className="tile-meta">{counts.get(area.slug) ?? 0} scenarios</span>
            </Link>
          ))}
        </div>
      )}
      {query && matchingLabs.length > 0 ? (
        <div className="search-results">
          <h3>Scenarios matching “{search.trim()}”</h3>
          <div className="tile-grid">
            {matchingLabs.map((lab) => (
              <Link key={lab.slug} to={`/${lab.area}/${lab.slug}`} className="tile tile-dark tile-compact">
                <h2>{lab.title}</h2>
                <p>{lab.summary}</p>
                <span className="tile-meta">{lab.area}</span>
              </Link>
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}
