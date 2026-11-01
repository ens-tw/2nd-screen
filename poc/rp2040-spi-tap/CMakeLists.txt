# RP2040 被動 SPI 擷取（防護評估用）
# 建置（在 Lima VM `pico` 內）：
#   export PICO_SDK_PATH=$HOME/pico-sdk
#   cmake -S /path/to/poc/rp2040-spi-tap -B /path/to/poc/build/spi-tap \
#         -G Ninja -DPICO_BOARD=adafruit_feather_rp2040
#   ninja -C /path/to/poc/build/spi-tap
# 產出 spi_tap.uf2，拖到 RPI-RP2 磁碟燒錄。
cmake_minimum_required(VERSION 3.13)

include($ENV{PICO_SDK_PATH}/pico_sdk_init.cmake)

project(spi_tap C CXX ASM)
set(CMAKE_C_STANDARD 11)
set(CMAKE_CXX_STANDARD 17)

pico_sdk_init()

add_executable(spi_tap
    spi_tap.c
    ${PICO_SDK_PATH}/src/rp2_common/pico_stdio_usb/stdio_usb_descriptors.c
)
target_include_directories(spi_tap PRIVATE ${CMAKE_CURRENT_LIST_DIR})
target_compile_definitions(spi_tap PRIVATE
    USBD_PRODUCT="SPI Tap Stream v2"
    PICO_STDIO_USB_USE_DEFAULT_DESCRIPTORS=1
    PICO_ENABLE_USB_RESET_VIA_VENDOR_INTERFACE=1
    PICO_USB_RESET_INCLUDE_DEFAULT_APP_DRIVER_CB=1
    PICO_USB_RESET_SUPPORT_MS_OS_20_DESCRIPTOR=1
    PICO_USB_RESET_MS_OS_20_DESCRIPTOR_ITF=2
)

# PIO 程式在建置時組譯成標頭
pico_generate_pio_header(spi_tap ${CMAKE_CURRENT_LIST_DIR}/spi_tap.pio)

target_link_libraries(spi_tap
    pico_stdlib
    hardware_pio
    hardware_dma
    tinyusb_device
    pico_stdio_usb_headers
    pico_usb_reset
    pico_unique_id
)

# 透過 USB CDC 把擷取結果倒回主機；不用 UART。
pico_enable_stdio_usb(spi_tap 0)
pico_enable_stdio_uart(spi_tap 0)

pico_add_extra_outputs(spi_tap)

# ── 擷取鏈自測：on-chip loopback（P-1）────────────────────────────────────
# 同板用 SIO 驅動 GP2/3/4 的已知 SPI 波形，再用同一支 spi_tap.pio 讀回比對。
# 毋需外接跳線或 目標板，純驗證 PIO 取樣＋DMA＋USB 這條擷取鏈。
add_executable(loopback_test
    loopback_test.c
)
pico_generate_pio_header(loopback_test ${CMAKE_CURRENT_LIST_DIR}/spi_tap.pio)
target_link_libraries(loopback_test
    pico_stdlib
    hardware_pio
    hardware_dma
)
pico_enable_stdio_usb(loopback_test 1)
pico_enable_stdio_uart(loopback_test 0)
pico_add_extra_outputs(loopback_test)

# ── 匯流排探針：被動診斷（無示波器時用）──────────────────────────────────
# 三支腳全輸入、關下拉、不驅動；用 PWM 硬體計 CLK 上升緣、板載 LED 心跳。
# 可安全在已接 目標板 活匯流排時執行（與 loopback_test 相反，後者會驅動腳位）。
add_executable(bus_probe
    bus_probe.c
)
target_link_libraries(bus_probe
    pico_stdlib
    hardware_pwm
    hardware_irq
    hardware_sync
)
pico_enable_stdio_usb(bus_probe 1)
pico_enable_stdio_uart(bus_probe 0)
pico_add_extra_outputs(bus_probe)

# Active, manual, one-shot display writer. Separate from the passive tap.
# Requires controller isolation and an additional D/C wire on Feather D9 / GP9.
add_executable(display_write_test display_write_test.c)
target_include_directories(display_write_test PRIVATE ${CMAKE_CURRENT_LIST_DIR})
target_link_libraries(display_write_test pico_stdlib)
target_compile_definitions(display_write_test PRIVATE
    USBD_PRODUCT="Display Write Test"
    PICO_STDIO_USB_ENABLE_RESET_VIA_BAUD_RATE=0
)
pico_enable_stdio_usb(display_write_test 1)
pico_enable_stdio_uart(display_write_test 0)
pico_add_extra_outputs(display_write_test)
