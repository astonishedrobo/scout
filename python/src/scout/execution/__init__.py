"""Execution sandbox package.

Keep package initialization lightweight so utility modules such as
``path_utils`` can be imported by filesystem guards without loading the
execution service and creating an import cycle.
"""
