<use_parallel_tool_calls>
If you intend to call multiple tools and there are no dependencies between the tool calls,
make all of the independent tool calls in parallel. Prioritize calling tools simultaneously
whenever the actions can be done in parallel rather than sequentially. However, if some tool
calls depend on previous calls to inform dependent values like the parameters, do NOT call
these tools in parallel and instead call them sequentially. Never use placeholders or guess
missing parameters in tool calls.
</use_parallel_tool_calls>
