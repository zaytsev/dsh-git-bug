{
  description = "dsh-git-bug — a DeepSeek Harness plugin that manages git-bug issues in the current workspace";

  inputs = {
    # Development and build inputs follow nixpkgs unstable; flake.lock pins the
    # exact revision this repository was last verified against.
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

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

    # One definition of the installed plugin tree: manifest, server half, built
    # browser half, and the loader patch. Both `packages` and the overlay call
    # this, so the overlay can never drift from the flake's own package, and it
    # takes the consumer's `pkgs` so overrides there are honored.
    mkPlugin = pkgs:
      pkgs.stdenvNoCC.mkDerivation {
        pname = "dsh-git-bug";
        version = "0.1.0";
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

    perSystem = system: let
      pkgs = nixpkgs.legacyPackages.${system};
      plugin = mkPlugin pkgs;
    in {
      # Everything the plugin build, its tests, and the runtime integration
      # checks need. `git-bug` is the executable the plugin itself drives.
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

      # Link it into a DSH module directory
      # (`DSH_HOME/node_modules/dsh-git-bug`) to make the loader row resolvable.
      packages.plugin = plugin;
      packages.default = plugin;

      # `nix run .#install` links the built plugin into the DSH module directory
      # and prints the launch command.
      apps.install = {
        type = "app";
        program = toString (pkgs.writeShellScript "dsh-git-bug-install" ''
          set -eu
          plugin=${plugin}
          home_dir=''${DSH_HOME:-$HOME/.config/dsh}
          target="$home_dir/node_modules"
          mkdir -p "$target"
          ln -sfn "$plugin" "$target/dsh-git-bug"
          echo "linked $plugin"
          echo "  -> $target/dsh-git-bug"
          echo "launch with the row mounted:"
          echo "  dsh --profile web --patch $plugin/cordis.patch.yml"
        '');
      };

      # `nix flake check` runs the plugin test suite in a hermetic HOME.
      checks.default = pkgs.stdenvNoCC.mkDerivation {
        pname = "dsh-git-bug-check";
        version = "0.1.0";
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

    # The plugin set on its own, for flakes that would rather read an output
    # than instantiate an overlay: `inputs.dsh-git-bug.dshPlugins.${system}.dsh-git-bug`.
    dshPlugins = eachSystem (system: {
      dsh-git-bug = mkPlugin nixpkgs.legacyPackages.${system};
    });

    # Overlay adding the set to a consumer's nixpkgs:
    #
    #   nixpkgs.overlays = [ inputs.dsh-git-bug.overlays.default ];
    #   # then: pkgs.dshPlugins.dsh-git-bug
    #
    # The merge keeps whatever another overlay already put in `dshPlugins`, so
    # several plugin flakes compose instead of replacing each other.
    overlays.default = final: prev: {
      dshPlugins = (prev.dshPlugins or {}) // {
        dsh-git-bug = mkPlugin final;
      };
    };
  };
}
