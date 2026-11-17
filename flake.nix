{
  description = "dsh-git-bug — a DeepSeek Harness plugin that manages git-bug issues in the current workspace";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = {
    self,
    nixpkgs,
  }: let
    systems = [
      "x86_64-linux"
      "aarch64-linux"
      "x86_64-darwin"
      "aarch64-darwin"
    ];
    eachSystem = nixpkgs.lib.genAttrs systems;

    # The package manifest is the only source of the package's own identity.
    manifest = nixpkgs.lib.importJSON (self + "/package.json");
    name = manifest.name;
    version = manifest.version;

    mkPackage = pkgs:
      pkgs.stdenvNoCC.mkDerivation {
        pname = name;
        inherit version;
        src = self;
        nativeBuildInputs = [pkgs.nodejs_24];
        buildPhase = ''
          node scripts/build-client.mjs
        '';
        installPhase = ''
          mkdir -p $out
          cp package.json README.md cordis.patch.yml index.js $out/
          cp -r src lib $out/
        '';
      };

    # One entry of pkgs.dshPlugins, in the shape programs.deepseek-harness
    # (settings.plugins) consumes — the shape pkgs/deepseek/plugins/dsh-utils.nix
    # builds.
    mkPlugin = pkgs: let
      staged = pkgs.runCommand "dsh-plugin-${name}" {} ''
        mkdir -p "$out/node_modules/${name}"
        cp -r --no-preserve=ownership ${mkPackage pkgs}/. "$out/node_modules/${name}/"
        cat > "$out/entry.mjs" <<EOF
        import * as mod from "${name}"
        export * from "${name}"
        export default mod.default ?? mod
        EOF
      '';
    in {
      __functor = spec: extra: spec // {config = spec.config // extra;};
      id = name;
      inherit name version;
      config = {};
      bundle = false;
      # Names the row after the package, so the host serves the browser half.
      client = true;
      package = staged;
      entry = "${staged}/entry.mjs";
      packageName = name;
      packageDir = "${staged}/node_modules/${name}";
      patch = null;
    };

    perSystem = system: let
      pkgs = nixpkgs.legacyPackages.${system};
      package = mkPackage pkgs;
    in {
      devShells.default = pkgs.mkShell {
        packages = with pkgs; [
          nodejs_24
          git
          git-bug
          jq
        ];
        shellHook = ''
          echo "dsh-git-bug dev shell"
          echo "  node    $(node --version)"
          echo "  git-bug $(git-bug version 2>/dev/null | head -n 1)"
          echo "  run 'npm run check' to rebuild the browser half and run the tests"
        '';
      };

      packages.plugin = package;
      packages.default = package;

      apps.install = {
        type = "app";
        program = toString (pkgs.writeShellScript "dsh-git-bug-install" ''
          set -eu
          plugin=${package}
          home_dir=''${DSH_HOME:-$HOME/.config/dsh}
          target="$home_dir/node_modules"
          mkdir -p "$target"
          ln -sfn "$plugin" "$target/dsh-git-bug"
          echo "linked $plugin"
          echo "  -> $target/dsh-git-bug"
        '');
      };

      checks.default = pkgs.stdenvNoCC.mkDerivation {
        pname = "${name}-check";
        inherit version;
        src = self;
        nativeBuildInputs = with pkgs; [
          nodejs_24
          git
          git-bug
        ];
        buildPhase = ''
          export HOME=$TMPDIR
          npm run check
        '';
        installPhase = "touch $out";
      };
    };
  in {
    devShells = eachSystem (system: (perSystem system).devShells);
    packages = eachSystem (system: (perSystem system).packages);
    apps = eachSystem (system: (perSystem system).apps);
    checks = eachSystem (system: (perSystem system).checks);

    overlays.default = final: prev: {
      dshPlugins = (prev.dshPlugins or {}) // {
        ${name} = mkPlugin final;
      };
    };
  };
}
