"""CLI: python -m eval.pdqi9.psyn {build,validate,schemas}."""

import argparse
import sys

from . import build, schema, validate


def main(argv=None):
    ap = argparse.ArgumentParser(prog="python -m eval.pdqi9.psyn", description="P-SYN script generator (text only)")
    sub = ap.add_subparsers(dest="cmd", required=True)
    b = sub.add_parser("build", help="write scripts, truth sheets, twins and manifest")
    b.add_argument("--out", required=True)
    b.add_argument("--seed", type=int, default=None, help="content seed (default: config.json seed)")
    v = sub.add_parser("validate", help="validate a built directory")
    v.add_argument("dir")
    sub.add_parser("schemas", help="rewrite schemas/*.schema.json")
    a = ap.parse_args(argv)
    if a.cmd == "build":
        cfg = build.load_config()
        seed = cfg["seed"] if a.seed is None else a.seed
        man = build.write(a.out, seed, cfg)
        print(f"built {man['total_scripts']} scripts, {len(man['files'])} files, "
              f"dev {man['counts']['by_split']['dev']} / test {man['counts']['by_split']['test']}")
        return 0
    if a.cmd == "validate":
        errs = validate.validate(a.dir)
        for e in errs[:200]:
            print(e)
        print(f"{len(errs)} errors")
        return 1 if errs else 0
    schema.write_schemas()
    print(f"wrote {len(schema.ALL)} schemas to {schema.SCHEMA_DIR}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
