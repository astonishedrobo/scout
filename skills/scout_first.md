# Scout First Research Approach

When a user asks for information about a specific "Topic" (and optionally provides a "Context" or "Location"), follow this systematic scouting procedure before diving into detailed analysis. This approach ensures you identify all relevant data sources before committing to a specific analysis path.

## The Scouting Procedure

1. **Broad Discovery**: Use `search_workspace` to query for the Topic and Context across all indexed files (PDFs, JSON, Markdown, CSV).
2. **Focused follow-up**: Once a promising file is known, call `search_workspace` again with the same (or refined) query and optional `path` set to that file — including PDFs. There is no separate PDF tool.
3. **Metadata Lookup**: Use `list_files` on directories like `data/` or `pdfs/` to identify files that might contain relevant structured data.
4. **Cross-Referencing**: If you find a location or topic in a PDF, check the `manifest` in your system prompt to see if there are corresponding CSV datasets (e.g., if mentioned in a vulnerability report, check `data/climate.csv`).

## Reporting to the User

Present a "Scouting Report" instead of a deep analysis. Your response should:
- **List Files**: Clearly list all files identified as relevant.
- **Provide Summaries**: For each file, provide a 1-2 sentence summary of *what* it contains and *why* it is relevant to the query.
- **Scope the Work**: Explicitly ask the user which of these sources they would like you to analyze in depth.

Do NOT perform complex correlations, data cleaning, or multi-step Python computations during the initial scouting phase. Match the user's initial breadth with a broad summary.
