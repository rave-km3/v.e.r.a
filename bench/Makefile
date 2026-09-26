# Build all benchmarks:   make
# Run everything:          ./run.sh            (see README.md)
CC      = gcc
CFLAGS  = -O2 -Wall -Wextra
LDLIBS  = -pthread

PROGS = ram_latency ram_bandwidth mkfile storage_latency storage_bandwidth \
        mmap_fault swap_fault

all: $(PROGS)

%: %.c common.h
	$(CC) $(CFLAGS) -o $@ $< $(LDLIBS)

clean:
	rm -f $(PROGS)
	rm -rf tmp

.PHONY: all clean
