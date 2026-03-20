publish bump="patch":
    #!/usr/bin/env bash
    set -euo pipefail

    latest=$(git tag --sort=-v:refname | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | head -1)
    latest=${latest:-v0.0.0}

    version="${latest#v}"
    major=$(echo "$version" | cut -d. -f1)
    minor=$(echo "$version" | cut -d. -f2)
    patch=$(echo "$version" | cut -d. -f3)

    case "{{bump}}" in
        major) major=$((major + 1)); minor=0; patch=0 ;;
        minor) minor=$((minor + 1)); patch=0 ;;
        patch) patch=$((patch + 1)) ;;
        *) echo "Error: bump must be major, minor, or patch (got '{{bump}}')"; exit 1 ;;
    esac

    tag="v${major}.${minor}.${patch}"
    echo "Latest tag : $latest"
    echo "New tag    : $tag"

    git tag "$tag"
    git push origin "$tag"

build:
    npm run build