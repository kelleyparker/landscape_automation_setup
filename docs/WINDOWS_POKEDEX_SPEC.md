# Windows Pokédex Application — Specification

## 1. Overview

A native Windows desktop application that lets users browse, search, and
reference Pokémon data — a classic "Pokédex" experience. The app is built
with WPF (.NET, C#) and works entirely offline against a local database
bundled with the application, so no internet connection is required to
browse Pokémon information.

## 2. Goals / Non-Goals

**Goals**
- Fast, responsive browsing and searching of Pokémon reference data.
- Fully functional with no network connection (offline-first).
- Clean, native Windows desktop experience.

**Non-Goals**
- No live data sync with an external API at runtime.
- No online multiplayer, trading, or social features.
- No user collection/catch-tracking (marking Pokémon as caught, personal
  notes, etc.) — out of scope for this version.

## 3. Target Platform

- **OS:** Windows 10 and Windows 11 (desktop).
- **Framework:** WPF on .NET 8 (LTS).
- **Language:** C#.

## 4. Core Features

- **Pokédex list view** — scrollable/paged list of all Pokémon, sortable
  by number or name.
- **Search & filter** — filter the list by name, Pokédex number, type,
  and generation.
- **Detail view** — selecting a Pokémon shows:
  - Sprite/artwork
  - Type(s)
  - Base stats (HP, Attack, Defense, Sp. Atk, Sp. Def, Speed)
  - Abilities
  - Height and weight
  - Evolution chain
  - Flavor text / description
- **Type effectiveness reference** — a chart or lookup showing type
  strengths/weaknesses (super effective, not very effective, immune).
- **Generation/region filter** — narrow the list to a specific
  generation or region.

## 5. Data Model

Local schema for a Pokémon entity:

| Field | Description |
|---|---|
| `Id` | Pokédex number (primary key) |
| `Name` | Species name |
| `Types` | One or two elemental types |
| `BaseStats` | HP, Attack, Defense, Sp. Atk, Sp. Def, Speed |
| `Abilities` | List of ability names (including hidden ability) |
| `Height` / `Weight` | Physical measurements |
| `EvolvesFrom` / `EvolvesTo` | Links to related Pokémon for the evolution chain |
| `SpritePath` | Path to the bundled sprite/artwork asset |
| `Description` | Flavor text |
| `Generation` | Generation/region the Pokémon was introduced in |

## 6. Data Source & Bundling Strategy

- The full dataset (Pokémon entries, stats, types, abilities, evolution
  chains, sprites, flavor text) is compiled once at build time from a
  public dataset (e.g. a static export from PokéAPI) into a local SQLite
  database file.
- The SQLite database and sprite/image assets are bundled with the
  application installer — no data is fetched over the network at
  runtime.
- Updating the dataset (e.g. for a new generation) means regenerating the
  bundled database and shipping an app update, not a live sync.

## 7. Architecture

- **Pattern:** MVVM (Model-View-ViewModel), standard for WPF apps.
  - **Views** — XAML pages/windows (list view, detail view, type chart).
  - **ViewModels** — expose bindable properties and commands for each
    view; handle search/filter logic.
  - **Models** — plain data classes matching the data model in Section 5.
  - **Data Access layer** — a repository that reads from the bundled
    local SQLite database (e.g. via EF Core or a lightweight ADO.NET/
    Dapper repository). No network/HTTP layer is required.

## 8. UI/UX Notes

- **Layout:** master-detail split — Pokémon list on one side, detail
  panel on the other (or a navigable detail page).
- **Navigation:** simple, keyboard- and mouse-friendly navigation between
  list, detail, and type-chart views.
- **Performance:** list virtualization to keep scrolling smooth across
  the full dataset (1000+ entries).
- **Theming:** basic light/dark support consistent with native Windows
  styling.

## 9. Non-Functional Requirements

- **Offline-first:** the app must be fully usable with no network
  connection.
- **Startup time:** fast cold start, since all data is local.
- **Memory footprint:** low, given the bundled dataset is read-only and
  queried on demand rather than loaded entirely into memory.
- **Packaging:** distributed as an MSIX package or a simple Windows
  installer.

## 10. Out of Scope / Future Considerations

The following are explicitly deferred and not part of this spec:

- Live data sync with an online API.
- User collection/catch-tracking and personal notes.
- Multiplayer, trading, or any online/social features.
