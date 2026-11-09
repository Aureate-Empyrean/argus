"""`python -m argus.face_worker <data>`: scan until the queue is empty, then exit."""

import logging
import sys
from pathlib import Path

from .db import Database
from .faces import sync_references
from .recognition import Engine, run
from .storage import MediaStore


def main():
    logging.basicConfig(level=logging.WARNING)
    data = Path(sys.argv[1])
    db = Database(data / "argus.sqlite3")
    run(db, MediaStore(data), Engine())
    sync_references(db)


if __name__ == "__main__":
    main()
