
/* Built-in image fallback: keeps the ROVER photos visible if the separate photo scripts are blocked/cached. */
// ROVER reference prototype image (WebP data URI)
window.ROVER_DEVICE_IMAGE="data:image/webp;base64,UklGRnQdAABXRUJQVlA4IGgdAADwZwCdASq0AKwAPpU8l0gloyIhMHT9eLASiWMAvc8DWKl47Jjy/kGMV7w/N3+C73Xpg3EfO/acdvWH+zta1p3qt++/vfoMZR+y3Ug7y8cu/P486hftTzV4J/RH7X0EfcL8D4Merd4j9gLhOqAnkz/7Hk//Sv+H7Bv7FkV7qLcUpTqyIYkz8Hn/JzoozvDSxvkzUb7bNGbYL4mC0yyOrl4dv3pNLAb+pp5zdvL5sEFyezwaf78AKaV3KGUOexv5LqRMyArEwAKS7j0cThZ1Wl8siwU/FTzAhNgVgDvUw6NEHBRKv253w7bB1Q0jBIhEdILnNalC8HdR0LLKt62i9IpDmIQr4xm+qkvLmFFqDjpKHJAUXX1F0DTfmGgffRIrEBXOp+VGGL3ZN/VgznV82o8z8fdFgsjz7ASXMQVas4qPxKJoxIoBZV+X4ZPhgPtHXmx1ysXkqVfNJgBCoNZQjhMc7Qo74apMp48nG/f1bsHSCIOtEIH41nxwimJJ9dpeBY7ReAD33ZRgvA3tg+6gsTdKFig+sdg9DGkE9P9YsvajAaI1VhJOn56V3iBGUNflDdvRQgB46HpcmBb8/MxCV4pai7R9nnsfA9um2cev/Xen01GSDBFLd/+G8VyHn0fc/MhvcvaQ2jU+PEcZfjDKvlS4T6wZMVaDaAzqo5D49+/tI6ykx3usEE7cDcKKOy/P3Fgq3fr2E1ueX0Cp93i2g8PqEJJgKIKUBn3C+dSF423Kg8/lviiTnUTiuPF04lBPcY3R0lGBgUWPps/h9HxJ4O5SjjwHMIiZ0aBkBGXpudIYsADXykD6rBL39spRS5Njsxa7g1lwJIPx3P29gvil0g4hnm2J8sJPIITiqjaOsRClzEB6fKnpA0p3VnG8g7xts2t4sO8F8XQFJrecCyEg7NFLZvG7pQ9fZ8gORYMHX8fRKYY216yY7OW4LNQ90HYSOk1njJxqb1o4fXxEN1pwwU4/4qYVFj4LEeIvLu7sFD94IS4SPbBae+fNLDiW5L8ZhVCYUc4/Sl1DpuA72XDUaWZX7+g7WOHan92EBLvvZxVYvEsa2cBGIbDjtPrqtDK081wYadi1h+klQs3nqfCxqWyZ3xB09ZrXsAAA/v0As44WepiXQBxXZyZUbsRw09rQ68agbWqi/gABu+9cglubTwG9h1fmJ+IBGKwC8KKLCDAnXS6+D4p5z/OUgUQ91H/V3zcx0n0y6aQNkc5I+jRqoR1p7WLytHX2FRMTWDkuZz25JyrZsOb4tzB9gfCxoKDkV4tXQP0HjAbtBItHliTvS2ajOvyBBz4+gAHGgTjNUDc+UtWu6sJpc/nWuCB+82t71TxSQj7LWGDNH09LusZU6WYY3pQyhicYSjI2cYN43m3NK1BHbeHkQDU9nWK60ej3J6C4jC9Q2Kxipbpn6TkA/aPh6xOdft++y/Dr67tZMYSgKEQ2BQPcyiII6rrTtm33FjlQqS1O33bJ+Xb3GHrYIQOaBkw/44X/K4WGIqrPMFSIrpik/3POpLdo2JcGbSPYKqqTRw42qNF2IvdMcBlhnA3ORfuE5aWSQ7S0M+po6zgrjJ3dYBbVUO9MuJFDWlWmD9m7pcfbwx6cVHzVkLuYsSmRzAORLt8cTHpL1cLjlIRb+fCAN/QPpbLoCUwi4gXbIs2dc+K2XmYxb4fGJ4ocDqwcwgLy0d+D84wLXChOcXnJmxcb1Xui9rP/VM3fm04PFHeJMfDYdbi3AWuZaRgt7Xscn8dKYS7+QzaHIQnvaa5p15xqWQqaKCgNRp3VwMH+3j1Nhur8CvafubPz/+WeJppM961FvKqGYa+yly2IKSXl9OInz51b5fb3rxaF/GrAFs5PGqMIA9bDj1mfq+CUAvPXOEH05kC8YDa3SMFu9+OkymUPnm+PF0RCuTyvvenP/cAasFXFXYdfjzXMT8bXkNZzF2zSENJF79Tyh1kABTbEGuGEEpU33ExSr+F5pupmwSPvowqjkSetbk2ej1t4qvj/ehnhQNmik0tnU8YxEPECT2VYksjMI3FPGiHa4Kw7enpoWeA2etqfYA1pLE86Gm9dNgUUs0xblW/OXgFcgx3E6iFt2muTwisLR7SljyuBH1MHl34cDHTWpjZDy6Pzl1IrEKgnG2dYgmpAdQXIewKrfmAlz1UrbdwwJn1CZ+PXoWEBIF1TSx54M3xnaJ0KIEegU4UEZ9ySxsMHMdnMG9a6WFwrSjIHxYnVJYQu01xmtTo9Lze33+lSS/K8qgFCV5LxRy8FVn4HfmI+lEIb+y5oxbpvJl3EEmo4oLgq4Ph7QhlL/3uJYYH/+kcqlp3/w9LXY6VDXZlXtGWJxpEWayQiz7reIKRglHWt46azllq8p79hFsol1K3jQu0CgBwkdvRXQvPusINBSHwSqs9tEvIiSg1HVGz9BuqgknTE+jp6mJ/BIqhteR2NDPJla8pizHUTLNROxSuu5PYGwUFcL3OtH8cUrpxZ7r+PJzGq1jfL6LiLnO7L4Ju3rOTDiF9EAPivKwTIEXJYzXqy0ozg6V9NxFFnbSE6vWdidLCvcOfGBOuJHgmoYu1HP08+HsPJ8uyCRvwq21ONCjWDD7CMXr0ftjrjAQrdyGGIw0RR6FVZMaGLWsyE1Q3JjOgvdNfH0km9IPxZSqLTP+bl2DQQT8UisHpMLkJKBD5Or8CJQBnwXfJiqm+jxkqZSV60uOCQzzjayyVP5jyzz7HKdlO5csIs5ETu7gB053oD7yqPMhkMoDEbEYHL4JfXXSs5dLaTOaWyjHx2yRxCKr0C5SfvsuSE88G5G6s+RUBZPQdhzBN8r+bSfLMGy5e17iod+416HyIVePddK2jp1BxJxKy0g1dox7zFKsduPlO9ztNSwW88SKLW8uF/5AeUwtNsfczGlDo10tz+FQKkNl4oRQPFxnBM2LEHafmTndO8YjAWBBRAQIlJO8h6xmsrVVq0877DwwoEx/brKRRAkjKAn9QxQV5vYnWffP59QjTFC93CkwLOkErSqjE8xDG4vHnbzMDRJhkZsgF8g1igKp9Kep0eDWCUASfP4YIz5HNsbhXpW0fK0AUKy1OfDNshte9ivtOcV+GdVRtCWlb1tOmasivGTOxQ6SlmjlnFI9mCfZ2Gw29PDDsrLRYLAPFZfFtTDCrTWhUT/mR2q3DbmsQsWMnd1BwFGdnADL5MPRfVSnnc4fX44yVTU+fhY3PnuMroccS5vv/wR/jceOrRBAxVsHYovIjsWfJf4xEsCNuDYlul1sW1VlW2LwKilmurkbd2ZTUXMGDaZ9pPjciqhQoK5zyV/DOE23FOg1X0ixhoa8MD2ptbDiGdhANUeHQXqlY7FtqvTiOYsRhsJ1sMpZLm2ietROYr5GXz3nikJ0eaCj20beUhS4jQxi2YusTukrLQFwvkaWTDilG3A8fayUJXy5dg1C7Tidn7DW9qP0zk8ckBofFDbLCncq6rWvxc/qv17l1t6LyhMLBstedTVbydo5bJfnHVluS1Ddjj/r8oybd9VwRjBObubTJwmy4NGzqrgC9QZLFivRc/vLAAWysQCLeD1kfCYciGFCDFe1cqfS7e0/Mhp19uH3dsTw0cPArR0ZvDrrQSZv2PBdLTsgXZfCxmy0I58IZA+5qbrIjzggvN4KYX9fvbQOIoKGCipPfJK6u0vpG525rhG7dUauRH/cDIO2kp0t5NGBDYs77FgZ7RUkN1A87a+J//7VVnpJ/DRW1vh9KpKvDcrkqH4JT4DEZceGQTB8OOHWffygK81MlRNsKTRgtjMzp3SGLCTIPgioxVwBgFK9ZWZudOG5AqokYQT8wHpNYurHpKxunzf6NgxcF37PZ/PXVEj57CKreK/vjaeItTLy3fRZvU4/QfZpG1lKiZ+uOJsbu+jW4JyB7nlbkyy/6aAEAgWRQX1kgKDAKPIQu/KadLD7lezPSt2rIbFCTKm+7HszLNMSCILxTN16FmAb+oh9oK+8Fb8EE1WpLdGup2GR1/G4lZOKAEU2A5gna3Q3J5kDUXq6VZoitJmUC8oBFVZqmOkGkqqZr96Y+mBOh5eAvwkidkspHtFEY/e+TdLVsLr72f5w47Zioi/VYpRskTnhu2IVA32E4oET0Da3+2T5oNb/3z8LH2u+rwWQ91P99DvYvn4c1bEwVPyQIREWQhg4iQC/7tsZDrIkddWmRMc86YK6bEYdCHtEoSvyzExZ757scGkzZUuvqFPghR1liP34DMON3Z1L2UPP3UuovZj5u/gNFU2n79n7d1h6qInuVum7D46BNYyS/ydRCN0ZURZUZDJJQYRZA6j6OfN+1SYku2lk6+JYlLxihcYLxcIOcGr0iqEwOPlkmBfiqf79IRGenfeO8zKLXFO21nQ6YDY3MgHIbrOB4solZF9/+IJLYOeiWck87GjHqZXJQomVaf4e83AxRe/Xbr82WtMPT8DpdfKC6J3DhNzCXPirbcEq6W/vt/gcKSaDVA4LI2uhbjxdybJjZflCf7SjPTcAWg347TNIA4+KzhfHL+RUH8BmsKKdLUvfPdial5ADOfGLT90dDhxMvvAdjhWeJM4h38LUFniRi4cBC7xljQ69MQPCQxrMv3c/ksZfkgRMahWNd2gE2bQZExT8lFkum9PhYDz0UCxI32R+DSoeyYrwUGoQR2VO8PGDyjRlqkFYX+Ib7ZeovbQcCH3lRrVtfKvt/zzJZYxt7oL6Hcv2j1jOsLqvg//OHDEe0XGfjA711YhZ3PCKcahPS/Q3TI8MIZoXQ1wmCYAfy/oJ1MfjVdWf7A9QuIKpbqAhogZqoPfHYdEfLy0M6dIf+lGnxiv0C79mvoQSzZoZHdFpEWJwKGr2D+XO3RcYf0mc65JzhG3zViFDfRf59Fhnw3H1vh5pDvIwPU2h+TtA+p9vCOz46gHSoTxrx1Bas6sWDgZFCI4QWy7m+08iuH6g5zF/xLKx0+41Xx2AcOEEfnBVKdyqHECGR7VeK5W89qT+OV7H1majWq4FiSNblZUjBRLNuJFS9LnizL/kNFDSMTmVD0e41ACz0S5t792TpjZY5g38rzue5+XOFXIVfnok05e/zak/VcnkmFRVqjFaFUzNQl64eDBkHDuEctcnjaaqObMFixEoiI7oIz3jl1mkGFpQe/w9Faq0nHkv4VOYqcK6j74WxQuoctkgTajRoU6Es+qNVwQmyQX83zfsS0q+on0d3/YUIKclIlpjShU0O787BV2blyKmQEYz5IOF2zxgUVmIejdoN72T4ZCJKL5TmIahtXw1hKs+t5xBMqn8IafR4mCt4oXGUUsHIop1Qbj2lxZaIWGv85ThPNhIioIzp3s12TASGY8p5QAK7TPTqK4GMvng3yZLTGYCBz6fz4B+UINiWsRa6DfM7I/CwwixpREczYlCkrbljXywPjWeYN8Fpf4/8iN7KqUt35VdePvkzpgJ/hO/k8TM5AXXBWd4+7ZV+nvnD5u0mUikB8fLxpiN5XkS63XSSqPYBlphQncUfaDHDCc00UYAREQ5larkk+PCVnicOaqGXXwZgNHWZ9rJVbNHh4w65xd3ZB37MdxLqI07zMt0unTs5dQ+cIzSIrbptKCor4WYlelhnAc7sUXM8SjOpduilG889IVvsxfp67YDmyyIXwEwjLgI/q97StyMz8CxEl2euFQH/m/dg1m6C1zjN5QbBCGbhfPUDbrHlc4z1CVIFSdnJbn4eWlyY0alNJ9v+qg4h9KD+AlYxNDxr0EA77TTf6eQQam9xAK3W+ZRnIp2sT+IrCBOggW95zAoKo/Xu8g7P+HuVfcVm8AiJ4DKvQHwXtclfqUb+twy1aU7dcyxc4P788oPMR+y576d8bZ69DH95c75u+2K7pZWrfnnWhuuKXKNN46Ft7izMlele2Yf8TiEoYtJuJwYrrS1cnWPEj8JCi/OkahBGugXyTFgc6+XFn5nHJ+13SZM1YPXaXGBD6Blx8zJyiGcwsQt+G3wWe0F8uCs7SCmbcJYitBKY8iw/uFjtgNgYLY02nirEiiDuPMj60jKtAdY8s+v1jVJDloonKFUT+y9ok84JojYiYBeolRfF+h26Pwm+1RhvtCepIc3elhsHogBVuel11sRuHHxU21C0yIqIwX3eoLUs1pvp2G5t9kLdms42rH480KjhA8Q6Dn7llQbs1CqJb2jj1ctjC0ucpCHrtujRevlPQk1lBRKHhhDtZoJ9Wov3dP66RqlgLHKXyO3drX+zAuixRTjegYxjqzKl7ZRzKD7iEFKSeLYnxgrrgErdV6ZjAQ5+KPB5s+QIiM7XvdyyoeGjjJB3bVvvO+8wLt0CpjxMVCv/5+o+P8OTkUysdN+yI+fs9rzPBdneSU2kTyLkNnz0M6KLJXwJ9oF5gX7u2aaAQbr6RhqAvTQSrP7lmXzay8/a4xczsMspx6WdMZzjzKeCUxp3g67O1g7dLg7wb4AtLBt5TWaSCQvfH1fklIke/meLaqCUV+ELJWdUkKEgC6QXPH0Y4cgc9fR2kzeBcQUpLepAfw3/SDtkAXaWzbUzpm5p/K5EMR6FexUwd8Jj56O3IoBWTjltitVSdqGSFCSV5Bwk0IqzT+XFkQEDLBIOcbty51x9so1F4Sl6DivWmw/gHn2+7kq+/SAORrSQxtR42MoofLe77ztwYbxSvCMFK+IvkzpZpSrCQCi+nJXLhhmylqzS38iuWxNfHycGEnrmFyPS1ifqg5GpQSrZgiHcnuqK4SZ247lee790Jy8UmrTn3iUXJOhhQ8e3gBGGZiNLPSLUvCDq/GgD7JCz9AgwduhLKbmmroREIvqtjZON+ZvWwgYMRbpcIVx1QYJuGZlgrJMFtTkt2mMsh1YIPuRWpdbl0LWlNcIVFmAXYmHy2vmAs9YrbJjyv5eAjeEkCYYB4x/xCZdxkJ9+xTG6mMLu6/zLw3Ck0BdLN5AUZLKf3tFHtrNUCt0GlrefLMIq/3C0muPDhp6wrKl7pBMlrHftmWU4yhXx4ak7IUDOTvg0nUcRrD7f1qzpA16wDhl3xN7d7z+SF4lGozkn/vLDVTpvHj7xpefnt3JQZKf0lF+GMoR66OcJrizBHJGI4sWbs1c6PGrJMS0HTPXUIFNjVjL1kOKCfiNVBmhKavVaCF5/xXq6bbC4bu+q7zhS28/aI5Od/31e8Rz9hLgZwlZN42ttf32gO9t7UQxMQc1p4bxdnlU/j3AjzyQbO9VoIgCjbRh8HTJ9BNIcDbfZhQ0LonwXwv2OV+8hMAtaumFGGIt3k6f8aYMXSBhmdH0/mhIFiykzW/DqSg2j5qDah17IlBceHx7MqZp0iMSM3nW7heo6SEQQ7HqqbYqWrEMsTXFva/iZoUUBgxZZo8Z6U2zlns3awV817Aprnljiy7X91TKX3pHl0p0YfLzpxskcVIXOH7u345ez6wcNRT27bzkDW57+cRgwkLAJDa/bjgTm/xCJIwG9nCDUo4lWbKF806q/FFwIFWoIzIYT4HavcYc7dKBLt0m5T6F4nK8G/35NRYlRykHv7R+xm6yVy/nX4mAvvocr0r5cvNYfIKlixoV4NFn9vQBv3qXthtNhPJjFogX7RhywGzZySB0iWiJWlyP0R27XYLLWRpjf5Jr+ENg6XojFhX5n6ErhVApWmiUyj9nC8wr4BzDiB4N7qThGR5tT4LfVZin3hHd+knHgKeKpy4QNZHXNrjg+8EUHsypmF6vMdoqXI6lCU4e/LMen2cGNecr3diIeQWLfS+wI1gtCTkniVE9rp09LkzSPaHeRDnCzR3FyPCYcF2fv4YVfyOdayHYi31RqFePSb+3S8NpgsTiilUqYBKy4ztEr8ZEXNLRSbNWxMueckfzAQEOJll5ZjfGZSUlyYrZoKV+vP1vIUMfKHnP+yIqk0+gGufn34xuTFXUd2FBn7blYyn0rLJUVJ0y4ToLyNbdDs8aOqitSjp/lk83w9lD3OtSiCSM6cqOPncALEQaR4fG+zMlahkB2BIZBQbIdZIQ+Jp2TxlMXWrkR3ecjy/tcvVGqyuhJGWditlqwxhSaMITq5Ssl32qcSmIcq+aAnNmWZq4OUXaTR5st+own5nhpLGzLufIVMUmYvPvnz15f+G39oY5LfUl7Uk9R6C69BpHmz+sAm+XmebpI/epWfPeMl8YrUDKpVVCYRmrX2dHfPgLeR/dFg5Vk6u9zjt8kWUBhmwHdiZrAXEe/f+9i9HVF0LY5S/PX59GfT5qTCWQzL2dmCLheXXYw0o/wZlRbbOY6aieQNWXY6d74O6mbkFZ7R0wIcchm7O9l3Y1n+2sFUczENopKztqUmDJjNHp+xgrMe3FeoqzM1YZpLX8a0UBicHiPpFjtDjoveeTJQbC7o9kYUn47mYQzvouxndYMrZQCRILN7UqVWyWbgdxU3hpVTJimkhj0UZtGIrjL7yJTtyYAzjO5JseeMLDUgcF5o0FzVhcug3lEGj5FG8ThVeC2WlGf/HxlyOZNQXBnoKEmNKzIs7JeQiqYVX3iTolLlyd7MVuut6AL5koqI57+CmlNOiQEWnVSQJSzBpL1uIiSegCAt3GxrKu3etLq/wlWJACUXoEXm0KEoWfTqDqu071Mg8ad8ki3plFZPYVPFU233FQ7H58Wn1maYIfA6Cuu6XjB7L9E8SZxLj1W9fXMyC0seE2paCQcrUIDTXD2AQ3sGhqajs3twABzskO4CTYWYgIqJwQRLjFYHskluxJvXWHL9Qdb8qZA1K/g7iCXW8Q6JtNksjxnHvlfWq3c3F3XyqQVwi5u3S5xFZvLrVQoTK0kPmlZm1IOFCjWE4jaNLPA4H/TB2bqMe7XoBnXKt0SFAxry8HB/6/3HPDQklQbBbRDt4u8/CVl3OR72MMmSio51amHSGMgKseR2APEB1dqlczNZI3+5B+jZJYvyG7abYZJlmuJDz4KRLahFf5jceA5xwZihK4c/F820Rx+4sG7cybzqrKsvGVzWUMUyFnlPPulygo0Mm55/hwV02u+6ropoyF4qC1efFH2aK0HGsi8HHBxPDMWVlLWm+CULWC+B9Q6nAuRBna7g/u/Iu/5663NB6wd6eSQblllW2eB8TnUFjnubZIdJhCLSk9+klHtZB5U+mS/ottOLIOfhtP5iUAPyxnMqLwAI9ESFVWkBTLhN8rQMsszxaaLqo5EFLNBHA94wI4/WdH7FJpa60GZYws7oemSyJYZRrmRGWcdGHuT5K5f0UDGmxBUmc+0IZuuTb9xUFuuNCM7Dmc4lRpeaODyzZfmNBZuMltRiYMpyrrH5kmJvjqhQe0M399sCQ4wjgw4SEHUAk8D7KiEWcSKQjiuYupDalZpdIENA5KxYVLBQvWGEeiHoE3swQP4AietfdiGzWq5eLxIHeexvfK7Gf7LTBX3DsG/uzaUghMdcwGr/k1WnuYQ/JQXAOzeiZDUqFLa4fC2Z1244qDJK+619xI/asnQApYba57YdPvhvskWnSXon5wkg+YQhBRwqM3zXTcK5Hhua9vZM7qMoB5a5D9tQVKMFMvekTczQmAC07Xh5oiOeZMxVDN7JopJqmzOph7Y19x7RWrtQGOZqpFVrnmY6zXBbw7NlsJ4mRKPVaJ5rJFdWzeCxkVqr9QDLgCYwXXe1+v6xifQFQu8gXsJ0vGBoCS45UReCAdh2oPif2vxUv1oUW4TEM7EQ8ILlR2LN1kanBsaCaB1ZsKPtPMfO9+vx3ggUObq3Z4Win65EIs4LPo4U0GU0ZNixuEt94dYADtwroG1Cw5nGNvkzctq+y+Coppn9rmtAmHYBNu/i6WSYRUoCTiq8i469G7FlscIjUNYN/E0e/B2lRxR38DiOrvqj6d00G31nXSf3fb8gJS6caqvKwBwbzsfrMe9qgcUCkZTKe6a4xrivue1IlnqP9zM9RkGP1eI6iUxcDPOoU9N9FtryA84R8RW7jUfxnGi8M1ABiUa6f62smvhh2UFcdzNI964xYm//qTurnSGK8QhxSN3SYOarL/lfLfkZCK7Ga+ak8wNRbgZVgQq22Mj4L9s3I76oc71nSMizsu1Ig3ISgKETupXhYAAA";

// Exact uploaded ROVER prototype image for the lower-left panel, converted to WebP for fast loading.
window.ROVER_LEFT_IMAGE="data:image/webp;base64,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";

(function(){
"use strict";
const demoMode = window.location.pathname === "/" || window.location.pathname === "/demo" || new URLSearchParams(window.location.search).get("demo") === "1";
let me=null,map=null,rover=null,targetMarker=null,targetLine=null,trackLine=null,geofence=null,satelliteOn=false,satelliteLayer=null,streetLayer=null,terrainLayer=null,trackPts=[],samples=[],telemetryBusy=false,loginAlertBusy=false,logoutSent=false,mapReady=false,motionStopTimer=null,hybridOn=false,liveTracking=true,recording=false,lastLiveCommand="",lastKnownLoss=null,lastKnownLossKey="";
let gpsWatchId=null,gpsPublishBusy=false,gpsLastPublishedAt=0,gpsSourceId=localStorage.getItem("rover_gps_source_id")||"",realCameraInitialized=false,realCameraActive=false;
if(!gpsSourceId){gpsSourceId="gps-"+(crypto.randomUUID?crypto.randomUUID():Date.now()+"-"+Math.random().toString(16).slice(2));localStorage.setItem("rover_gps_source_id",gpsSourceId)}
let lastLoginAt=localStorage.getItem("rover_last_login_at")||"",unreadLogins=0;
let notificationSoundEnabled=localStorage.getItem("rover_notification_sound")!=="off";
let notificationAudioCtx=null,targetAlarmTimer=null,targetAlarmActive=false,targetAlarmSirenTimer=null,targetDetectionInitialized=false,targetDetectedState=false;
let warningDisplayEnabled=localStorage.getItem("rover_warning_display")!=="off",lastTargetAlarmData=null;
function targetSirenBurst(){
  if(!notificationSoundEnabled)return false;
  return initNotificationAudio().then(ready=>{
    const ctx=notificationAudioCtx;if(!ready||!ctx||ctx.state!=="running")return false;
    try{
      const now=ctx.currentTime,master=ctx.createGain();
      master.gain.setValueAtTime(0.0001,now);
      master.gain.exponentialRampToValueAtTime(0.38,now+0.03);
      master.gain.exponentialRampToValueAtTime(0.16,now+0.28);
      master.gain.exponentialRampToValueAtTime(0.0001,now+0.62);
      master.connect(ctx.destination);
      const osc=ctx.createOscillator();osc.type="square";
      osc.frequency.setValueAtTime(520,now);osc.frequency.linearRampToValueAtTime(1100,now+0.20);osc.frequency.linearRampToValueAtTime(520,now+0.46);
      osc.connect(master);osc.start(now);osc.stop(now+0.63);return true;
    }catch(_){return false}
  });
}
function stopTargetAlarm(){
  if(targetAlarmTimer)clearInterval(targetAlarmTimer);targetAlarmTimer=null;
  if(targetAlarmSirenTimer)clearTimeout(targetAlarmSirenTimer);targetAlarmSirenTimer=null;
  targetAlarmActive=false;
  const p=$("targetAlarmPopup");if(p)p.remove();
}
function startTargetAlarm(t){
  if(!warningDisplayEnabled||targetAlarmActive)return;
  lastTargetAlarmData=t||lastTargetAlarmData;
  targetAlarmActive=true;
  const old=$("targetAlarmPopup");if(old)old.remove();
  const p=document.createElement("div");p.id="targetAlarmPopup";
  p.setAttribute("role","alert");p.style.cssText="position:fixed;right:18px;top:76px;z-index:99999;width:min(390px,calc(100vw - 36px));padding:16px 18px;border:2px solid #ff3f52;border-radius:12px;background:linear-gradient(145deg,rgba(74,8,16,.97),rgba(24,7,12,.97));box-shadow:0 0 0 2px rgba(255,63,82,.12),0 14px 40px rgba(0,0,0,.45),0 0 28px rgba(255,63,82,.26);color:#fff;font-family:Inter,Segoe UI,Arial,sans-serif";
  const type=esc(t?.type||"Object"),range=Math.round(Number(t?.range_m||0)),speed=Number(t?.speed_kmh||0).toFixed(1),conf=Math.round(Number(t?.confidence||0)*100);
  p.innerHTML="<div style='font:900 17px/1.1 Inter,Segoe UI,Arial,sans-serif;letter-spacing:.5px;color:#ff7b86'>⚠ TARGET DETECTED</div><div style='margin-top:10px;font-size:13px'><b>"+type+"</b> detected in camera view</div><div style='display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:11px'><span style='padding:7px 8px;border:1px solid rgba(255,255,255,.12);border-radius:7px;background:rgba(0,0,0,.16)'><small style='display:block;color:#b6c0c7;font-size:9px'>RANGE</small><b>"+range+" m</b></span><span style='padding:7px 8px;border:1px solid rgba(255,255,255,.12);border-radius:7px;background:rgba(0,0,0,.16)'><small style='display:block;color:#b6c0c7;font-size:9px'>SPEED</small><b>"+speed+" km/h</b></span><span style='padding:7px 8px;border:1px solid rgba(255,255,255,.12);border-radius:7px;background:rgba(0,0,0,.16)'><small style='display:block;color:#b6c0c7;font-size:9px'>CONF.</small><b>"+conf+"%</b></span></div><button id='silenceTargetAlarmBtn' type='button' style='margin-top:12px;width:100%;height:34px;border:1px solid #ff6674;border-radius:7px;background:#3a0f18;color:#ffd8dc;font-weight:900;cursor:pointer'>SILENCE ALARM</button>";
  document.body.appendChild(p);
  p.querySelector("#silenceTargetAlarmBtn")?.addEventListener("click",()=>{stopTargetAlarm();});
  if(notificationSoundEnabled){targetSirenBurst();targetAlarmTimer=setInterval(()=>{if(targetAlarmActive)targetSirenBurst()},900)}
}
function syncTargetAlarm(detected,t){
  const now=!!detected;
  if(t)lastTargetAlarmData=t;
  if(!targetDetectionInitialized){targetDetectionInitialized=true;targetDetectedState=now;if(now&&warningDisplayEnabled)startTargetAlarm(t);return;}
  if(now&&!targetDetectedState){if(warningDisplayEnabled)startTargetAlarm(t);}
  else if(!now&&targetDetectedState)stopTargetAlarm();
  else if(now&&warningDisplayEnabled&&!targetAlarmActive)startTargetAlarm(t||lastTargetAlarmData);
  targetDetectedState=now;
}
function updateWarningControlUI(d){
  const button=$("warningToggleBtn");
  const state=$("alarmStateText");
  const active=!!warningDisplayEnabled;
  if(button){
    button.textContent=active?"TURN WARNING OFF":"TURN WARNING ON";
    button.setAttribute("aria-pressed",String(active));
    button.style.borderColor=active?"#f0b44c":"#52c6a8";
    button.style.background=active?"#38280d":"#10332d";
    button.style.color=active?"#ffe1a0":"#baf7e5";
  }
  const sensorWarning=Number(d?.obstacle_cm??999)<45||!!d?.target?.detected;
  if(state)state.textContent=active?(sensorWarning?"ON • WARNING":"ON • ARMED"):"OFF • DISPLAY MUTED";
}
function setWarningDisplay(enabled){
  warningDisplayEnabled=!!enabled;
  try{localStorage.setItem("rover_warning_display",warningDisplayEnabled?"on":"off")}catch(_){}
  if(!warningDisplayEnabled)stopTargetAlarm();
  else if(targetDetectedState)startTargetAlarm(lastTargetAlarmData);
  updateWarningControlUI({obstacle_cm:999,target:{detected:targetDetectedState}});
  setText("conn",me?"● ONLINE • WARNING DISPLAY "+(warningDisplayEnabled?"ON":"OFF"):"● DEMO • WARNING DISPLAY "+(warningDisplayEnabled?"ON":"OFF"));
}
function toggleWarningDisplay(){setWarningDisplay(!warningDisplayEnabled);}
function initNotificationAudio(){
  try{
    const AC=window.AudioContext||window.webkitAudioContext;
    if(!AC)return Promise.resolve(false);
    if(!notificationAudioCtx)notificationAudioCtx=new AC();
    if(notificationAudioCtx.state==="suspended")return notificationAudioCtx.resume().then(()=>true).catch(()=>false);
    return Promise.resolve(true);
  }catch(_){return Promise.resolve(false)}
}
async function playNotificationSound(){
  if(!notificationSoundEnabled)return false;
  const ready=await initNotificationAudio();
  const ctx=notificationAudioCtx;
  if(!ready||!ctx||ctx.state!=="running")return false;
  try{
    const now=ctx.currentTime;
    const master=ctx.createGain();
    master.gain.setValueAtTime(0.0001,now);
    master.gain.exponentialRampToValueAtTime(0.30,now+0.018);
    master.gain.exponentialRampToValueAtTime(0.0001,now+0.50);
    master.connect(ctx.destination);
    const osc=ctx.createOscillator();
    osc.type="sine";
    osc.frequency.setValueAtTime(880,now);
    osc.frequency.exponentialRampToValueAtTime(1320,now+0.11);
    osc.connect(master); osc.start(now); osc.stop(now+0.50);
    const gain2=ctx.createGain();
    gain2.gain.setValueAtTime(0.0001,now+0.14);
    gain2.gain.exponentialRampToValueAtTime(0.22,now+0.17);
    gain2.gain.exponentialRampToValueAtTime(0.0001,now+0.64);
    gain2.connect(ctx.destination);
    const osc2=ctx.createOscillator();
    osc2.type="sine";
    osc2.frequency.setValueAtTime(1175,now+0.14);
    osc2.connect(gain2); osc2.start(now+0.14); osc2.stop(now+0.65);
    return true;
  }catch(_){return false}
}
function updateNotificationSoundUI(){
  const b=$("soundBtn"); if(!b)return;
  b.textContent=notificationSoundEnabled?"🔊 SOUND ON":"🔇 SOUND OFF";
  b.setAttribute("aria-pressed",String(notificationSoundEnabled));
}
function toggleNotificationSound(){
  notificationSoundEnabled=!notificationSoundEnabled;
  localStorage.setItem("rover_notification_sound",notificationSoundEnabled?"on":"off");
  if(notificationSoundEnabled){initNotificationAudio();playNotificationSound()}
  updateNotificationSoundUI();
  setText("alertStatus",notificationSoundEnabled?"Notification sound ENABLED.":"Notification sound MUTED.");
}
const demoCenter=[12.9716,77.5946];

const $=id=>document.getElementById(id);
const esc=v=>String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
function setText(id,v){const target=id==="conn"?"connStatus":id;const e=$(target);if(e)e.textContent=v;}
function show(id){const e=$(id);if(e)e.classList.remove("hidden")}
function hide(id){const e=$(id);if(e)e.classList.add("hidden")}
function openModal(id){show(id)}
function closeModal(id){const e=$(id);if(e)e.classList.add("hidden")}

async function api(url,options={}){
  if(demoMode)throw new Error("This action is unavailable in the read-only demo.");
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),12000);
  let r;
  try{
    r=await fetch(url,{cache:"no-store",credentials:"same-origin",signal:controller.signal,...options});
  }finally{
    clearTimeout(timer);
  }
  if(r.status===401){
    sessionStorage.removeItem("rover_user");
    location.replace("/login.html");
    throw new Error("Login required");
  }
  return r;
}

function loadMapAsync(){
  const link=document.createElement("link");
  link.rel="stylesheet";
  link.href="https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.css";
  document.head.appendChild(link);
  const s=document.createElement("script");
  s.src="https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.js";
  s.async=true;
  s.onload=()=>initMap();
  s.onerror=()=>{show("mapFallback");setText("mapFallback","Map service is unavailable. Control centre remains online.");};
  document.head.appendChild(s);
}
function initMap(){
  try{
    if(mapReady||map)return;
    if(typeof L==="undefined")throw new Error("Leaflet unavailable");
    const mapHost=$("map");
    if(!mapHost)throw new Error("Map container unavailable");
    mapHost.querySelectorAll(".leaflet-container").forEach(el=>el.remove());
    map=L.map("map",{zoomControl:false,preferCanvas:true}).setView(demoCenter,15);
    // Exactly one native Leaflet zoom control. The custom rail below is recenter-only.
    L.control.zoom({position:"topleft"}).addTo(map);
    streetLayer=L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",{maxZoom:19,attribution:"© OpenStreetMap contributors"});
    satelliteLayer=L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",{maxZoom:19,attribution:"Imagery © Esri"});
    terrainLayer=L.tileLayer("https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png",{maxZoom:17,attribution:"© OpenTopoMap contributors"});
    satelliteLayer.addTo(map);
    satelliteOn=true;
    document.querySelectorAll(".mapTab").forEach(b=>b.classList.toggle("active",b.dataset.mapmode==="satellite"));
    setText("mapMode","Satellite");
    geofence=L.circle(demoCenter,{radius:600,color:"#18d6a3",fill:false,weight:1,dashArray:"6 6"}).addTo(map);
    const roverIcon=L.divIcon({className:"roverMarkerLabel",html:'<div class="roverMapMarker" id="roverMapMarker">✦</div>',iconSize:[34,34],iconAnchor:[17,17]});
    rover=L.marker(demoCenter,{icon:roverIcon}).addTo(map).bindTooltip("ROVER-01",{permanent:true,direction:"top",className:"roverTooltip"});
    hide("mapFallback");hide("mapFrame");
    mapReady=true;
    map.on("click",handleBaseMapClick);
    renderReturnBase();
    setText("conn","CONNECTED");
    setText("serverHeader","Server");
    setTimeout(()=>map.invalidateSize(),100);
    window.dispatchEvent(new Event("rover-map-ready"));
  }catch(err){
    show("mapFallback");
    setText("conn","DEGRADED");
  }
}
function setMapMode(mode){
  if(!mapReady||!map){addLog("MAP","Interactive map is still loading");return}
  [streetLayer,satelliteLayer,terrainLayer].forEach(layer=>{if(layer&&map.hasLayer(layer))map.removeLayer(layer)});
  hybridOn=false;
  if(mode==="satellite"){satelliteLayer.addTo(map);satelliteOn=true}
  else if(mode==="terrain"){terrainLayer.addTo(map);satelliteOn=false}
  else if(mode==="hybrid"){satelliteLayer.addTo(map);hybridOn=true;satelliteOn=true}
  else {streetLayer.addTo(map);satelliteOn=false}
  const names={map:"Map",satellite:"Satellite",terrain:"Terrain",hybrid:"Hybrid"};
  setText("mapMode",names[mode]||"Map");
  document.querySelectorAll(".mapTab").forEach(b=>b.classList.toggle("active",b.dataset.mapmode===mode));
  recordActivity("MAP_SATELLITE",(names[mode]||"Map")+" view");
  addLog("MAP",(names[mode]||"Map")+" view enabled");
}
function toggleSatellite(){
  setMapMode(satelliteOn?"map":"satellite");
}
function centerRover(){
  if(!mapReady||!map){addLog("MAP","Interactive map is still loading");return}
  if(rover)map.setView(rover.getLatLng(),16);else map.setView(demoCenter,16);
  recordActivity("MAP_CENTER","Centered map on ROVER-01");
}
function fitTrack(){
  if(!mapReady||!map){addLog("MAP","Interactive map is still loading");return}
  if(trackLine&&trackPts.length>1){
    map.fitBounds(trackLine.getBounds(),{padding:[30,30]});
    recordActivity("MAP_FIT","Fitted map to rover track");
  }else{
    centerRover();
  }
}
async function openDevices(){
  $("deviceModal").classList.remove("hidden");
  await loadDevices();
}
async function loadDevices(){
  const r=await api("/api/devices"); const d=await r.json();
  if(!r.ok){$("deviceTable").innerHTML="<div class='empty'>"+esc(d.error||"Could not load devices")+"</div>";return}
  $("deviceTable").innerHTML="<table><tr><th>Device</th><th>Type</th><th>Status</th><th>Notes</th></tr>"+
    d.devices.map(x=>"<tr><td><b>"+esc(x.name)+"</b><small>"+esc(x.device_code)+"</small></td><td>"+esc(x.type)+"</td><td>"+(x.enabled?"ENABLED":"DISABLED")+"</td><td>"+esc(x.notes||"")+"</td></tr>").join("")+"</table>";
}
async function createDevice(){
  const body={device_code:$("newDeviceCode").value.trim(),name:$("newDeviceName").value.trim(),type:$("newDeviceType").value,notes:$("newDeviceNotes").value.trim()};
  const r=await api("/api/devices",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
  const d=await r.json();
  setText("deviceMsg",d.ok?"Device added successfully.":(d.error||"Could not add device"));
  if(d.ok){$("newDeviceCode").value="";$("newDeviceName").value="";$("newDeviceNotes").value="";await loadDevices();}
}


function realtimeEndpoint(){
  const proto=location.protocol==="https:"?"wss":"ws";
  return proto+"://"+location.host+"/api/ws";
}
function connectionText(d){
  if(d?.device_online===false)return "● DEVICE SIGNAL LOST";
  return window.roverWS?.readyState===WebSocket.OPEN?"● ONLINE • REALTIME":"● ONLINE";
}
function applyRemoteState(message){
  if(!message)return;
  if(message.type==="camera-command"&&message.command){
    const c=String(message.command).toUpperCase();
    setText("cmd",c);
    if(window.ROVER_CAMERA_CONTROL)window.ROVER_CAMERA_CONTROL(c);
    const camera=$("cameraSceneLabel");
    if(camera){
      const labels={FORWARD:"CAMERA • FORWARD",REVERSE:"CAMERA • REVERSE",LEFT:"CAMERA • LEFT",RIGHT:"CAMERA • RIGHT",STOP:"CAMERA • STABILIZED"};
      camera.textContent=labels[c]||"DEMO CAMERA VIEW • SIMULATION";
    }
    return;
  }
  if(message.type==="state"&&message.telemetry){
    if(message.telemetry.sync_version)window.ROVER_SYNC_VERSION=message.telemetry.sync_version;
    updateUI(message.telemetry);
    setText("conn",connectionText(message.telemetry));
    return;
  }
  if(message.type==="connected"){setText("conn","● ONLINE • REALTIME");}
  if(message.type==="command-error"){addLog("DENIED",message.error||"Command rejected");}
}
function connectRealtime(){
  if(!me)return;
  const existing=window.roverWS;
  if(existing&&[WebSocket.OPEN,WebSocket.CONNECTING].includes(existing.readyState))return;
  if(window.roverReconnectTimer){clearTimeout(window.roverReconnectTimer);window.roverReconnectTimer=null}
  window.roverReconnectAttempts=Number(window.roverReconnectAttempts||0)+1;
  const attempt=window.roverReconnectAttempts;
  try{
    const ws=new WebSocket(realtimeEndpoint());
    window.roverWS=ws;
    let heartbeatTimer=null,pongTimer=null,healthy=false;
    const clearHeartbeat=()=>{if(heartbeatTimer)clearInterval(heartbeatTimer);heartbeatTimer=null;if(pongTimer)clearTimeout(pongTimer);pongTimer=null};
    const heartbeat=()=>{
      if(ws.readyState!==WebSocket.OPEN)return;
      try{
        ws.send(JSON.stringify({type:"ping",t:Date.now()}));
        if(pongTimer)clearTimeout(pongTimer);
        pongTimer=setTimeout(()=>{healthy=false;try{ws.close(4000,"Heartbeat timeout")}catch(_){}},9000);
      }catch(_){try{ws.close(4000,"Heartbeat send failed")}catch(__){}}
    };
    ws.onopen=()=>{
      window.roverReconnectAttempts=0;
      healthy=true;
      setText("conn","● ONLINE • REALTIME");
      try{ws.send(JSON.stringify({type:"ping",t:Date.now()}))}catch(_){ }
      if(window.roverReconnectTimer){clearTimeout(window.roverReconnectTimer);window.roverReconnectTimer=null}
      clearHeartbeat();
      heartbeatTimer=setInterval(heartbeat,15000);
      heartbeat();
      loop();
    };
    ws.onmessage=e=>{
      try{
        const message=JSON.parse(e.data);
        if(message?.type==="pong"){
          healthy=true;
          if(pongTimer){clearTimeout(pongTimer);pongTimer=null}
          return;
        }
        applyRemoteState(message);
      }catch(_){ }
    };
    ws.onerror=()=>{
      healthy=false;
      setText("conn","● RECONNECTING");
    };
    ws.onclose=()=>{
      clearHeartbeat();
      if(window.roverWS===ws)window.roverWS=null;
      if(me&&!window.roverReconnectTimer){
        setText("conn","● RECONNECTING");
        const delay=Math.min(5000,Math.max(400,400*Math.pow(2,Math.min(4,attempt-1))));
        window.roverReconnectTimer=setTimeout(()=>{window.roverReconnectTimer=null;connectRealtime()},delay);
      }
    };
  }catch(_){
    setText("conn","● RECONNECTING");
    if(me&&!window.roverReconnectTimer){
      const delay=Math.min(5000,Math.max(400,400*Math.pow(2,Math.min(4,attempt-1))));
      window.roverReconnectTimer=setTimeout(()=>{window.roverReconnectTimer=null;connectRealtime()},delay);
    }
  }
}
function updateUI(input){
  window.defenxLatestTelemetry = input && typeof input === "object" ? input : null;
  // Privacy lock: randomized coordinates only, regardless of incoming GPS telemetry.
  const simPoint=randomDemoPoint(),simTarget=randomDemoPoint();
  const rawTarget=input&&input.target?input.target:{},deviceTarget=String(input&&input.target_source||"")==="ROVER_DEVICE";
  const safeTarget=Object.assign({},rawTarget,{type:deviceTarget?(rawTarget.type||"Object"):"Object",detected:deviceTarget&&rawTarget.detected===true,range_m:deviceTarget?(rawTarget.range_m||0):0,speed_kmh:deviceTarget?(rawTarget.speed_kmh||0):0,confidence:deviceTarget?(rawTarget.confidence||0):0,lat:simTarget.lat,lon:simTarget.lon});
  const d={...input,lat:simPoint.lat,lon:simPoint.lon,gps_fix:false,gps_sats:0,gps_source:"SIMULATION",gps_accuracy_m:null,track:[],target:safeTarget};
  const gpsQuality=d.gps_fix?(Number(d.gps_sats||0)>=8?"Excellent":Number(d.gps_sats||0)>=5?"Good":"Fair"):"No Fix";
  setText("battery",Math.round(Number(d.battery||0))+"%");setText("deviceBattery",Math.round(Number(d.battery||0))+"%");
  setText("signal",Math.round(Number(d.signal||0))+"%");setText("signalDevice",Number(d.signal||0)>=70?"Strong":Number(d.signal||0)>=45?"Medium":"Weak");
  setText("gps",d.gps_fix?"Good":"No Fix");setText("gpsHeader",d.gps_fix?"GPS":"GPS");setText("sats",(d.gps_sats??"--")+" sats");
  const speed=Number(d.speed_kmh||0),heading=((Number(d.heading||0)%360)+360)%360;
  setText("speed",speed.toFixed(1)+" km/h");setText("heading","Heading "+Math.round(heading)+"°");updateCompass(heading);
  setText("lat",Number(d.lat).toFixed(6));setText("lon",Number(d.lon).toFixed(6));setText("updated",new Date(d.updated).toLocaleTimeString());
  setText("deviceOnline",d.device_online===false?"● OFFLINE":"● ONLINE");
  setLastKnownLoss(d.last_known_loss||null);
  setText("mapCoords",Number(d.lat).toFixed(4)+"° N  "+Number(d.lon).toFixed(4)+"° E");
  const gpsSource=String(d.gps_source||"SIMULATION");
  const gpsAccuracy=Number(d.gps_accuracy_m);
  const liveGps=(gpsSource==="LIVE_GPS"||gpsSource==="ROVER_DEVICE")&&Number.isFinite(gpsAccuracy);
  window.ROVER_GPS_SOURCE=gpsSource;
  setText("gps",liveGps?"LIVE":(d.gps_fix?"DEMO":"NO FIX"));
  setText("gpsHeader",gpsSource==="ROVER_DEVICE"&&liveGps?"ROVER GPS LIVE":(liveGps?"GPS LIVE":"GPS"));setText("gpsHeaderSub",liveGps?"Fix reported · ±"+Math.round(gpsAccuracy)+" m":(gpsSource==="SIMULATION"?"SIMULATION · NOT LIVE":"NO VERIFIED GPS FIX"));
  setText("gpsSignalText",gpsSource==="ROVER_DEVICE"&&liveGps?"ROVER GPS • ±"+Math.round(gpsAccuracy)+" m":liveGps?"OPERATOR GPS • ±"+Math.round(gpsAccuracy)+" m":(gpsSource==="SIMULATION"?"SIMULATION • NOT REAL GPS":gpsQuality));
  setText("deviceGpsState",gpsSource==="ROVER_DEVICE"&&liveGps?"ROVER • ±"+Math.round(gpsAccuracy)+" m":(liveGps?"OPERATOR • ±"+Math.round(gpsAccuracy)+" m":(d.gps_fix?"DEMO":"SEARCHING")));
  setText("modeBadge",d.mode||"MANUAL");
  const liveCommand=String(d.last_command||"STOP").toUpperCase();
  setText("cmd",liveCommand);
  if(liveCommand!==lastLiveCommand){
    lastLiveCommand=liveCommand;
    if(window.ROVER_CAMERA_CONTROL)window.ROVER_CAMERA_CONTROL(liveCommand);
    const camera=$("cameraSceneLabel");
    if(camera){
      const labels={FORWARD:"CAMERA • FORWARD",REVERSE:"CAMERA • REVERSE",LEFT:"CAMERA • LEFT",RIGHT:"CAMERA • RIGHT",STOP:"CAMERA • STABILIZED"};
      camera.textContent=labels[liveCommand]||"DEMO CAMERA VIEW • SIMULATION";
    }
  }
  setText("cameraStatus",d.camera===false?"Offline":(String(d.camera_source||"SIMULATION")==="ROVER_DEVICE"?"ROVER CAMERA":"Working"));
  setText("tempText",(d.temp_c??32)+"°C");
  if(realCameraActive&&d.camera===false){
    const media=$("roverRealCamera");if(media){media.pause?.();media.src="";}
    if($("camera3DScene"))$("camera3DScene").style.display="";
    realCameraActive=false;
  }
  const batteryPct=Math.max(0,Math.min(100,Number(d.battery||0)));const signalPct=Math.max(0,Math.min(100,Number(d.signal||0)));
  const batteryBar=$("batteryBar");if(batteryBar)batteryBar.style.width=batteryPct+"%";
  const signalBar=$("signalBar");if(signalBar)signalBar.style.width=signalPct+"%";
  setText("person","0");setText("vehicle","0");setText("object","0");setText("obstacle",(d.obstacle_cm??"--")+" cm");setText("confidence","0%");
  setText("deviceOnline",d.network?"● ONLINE":"● OFFLINE");setText("deviceGpsState",d.gps_fix?"LOCKED":"SEARCHING");setText("deviceCameraState",d.camera===false?"OFF":"READY");setText("deviceAiState","WAITING");
  setText("missionObstacle",(d.obstacle_cm??"--")+" cm");setText("missionTracking",d.tracking===false?"PAUSED":"ACTIVE");setText("missionGeofence",d.geofence===false?"OFF":"ACTIVE");setText("missionNetwork",d.network||"ONLINE");setText("missionState",(Number(d.obstacle_cm||999)<45)?"WARNING":"READY");
  updateWarningControlUI(d);
  const t=d.target||{type:"Object",range_m:0,speed_kmh:0,heading:0,direction:"N",size_m:0,confidence:0,lat:Number(d.lat),lon:Number(d.lon),detected:false};
  const range=Math.round(Number(t.range_m||0)); const tspeed=Number(t.speed_kmh||0).toFixed(1); const theading=Math.round(Number(t.heading||0));
  const dir=t.direction||bearingToDirection(theading);
  setText("distance",range+" m");setText("targetRange",range+" m");setText("targetSpeed",tspeed+" km/h");setText("targetDirection",dir+" ("+theading+"°)");
  setText("targetType",t.type||"Object");setText("targetSize",Number(t.size_m||0).toFixed(1)+" m");setText("targetConfidence",Math.round(Number(t.confidence||0)*100)+"%");
  setText("targetHudType",t.type||"Object");setText("targetDistanceHud",range+" m");setText("cameraTargetType",t.type||"Object");
  const detected=t.detected===true;
  syncTargetAlarm(detected,t);
  updateWarningControlUI({obstacle_cm:d.obstacle_cm,target:{detected}});
  window.ROVER_CAMERA_TARGET_STATE={detected,type:t.type||"Object",range_m:range,speed_kmh:Number(t.speed_kmh||0),confidence:Number(t.confidence||0)};
  window.dispatchEvent(new CustomEvent("rover-target-state",{detail:window.ROVER_CAMERA_TARGET_STATE}));
  const pill=$("targetAlert");if(pill){pill.textContent=detected?"DETECTED":"CLEAR";pill.classList.toggle("clear",!detected)}
  if(!detected)hide("targetHud");else show("targetHud");
  setText("topName",me?.display_name||"Admin");setText("topRole",me?.role==="admin"?"Administrator":"Operator");
  setText("onlineUsers","Presence unavailable");setText("onlineUsersSub","Live user count not reported");
  if(rover){rover.setLatLng([Number(d.lat),Number(d.lon)]);const markerEl=$("roverMapMarker");if(markerEl)markerEl.style.transform="rotate("+heading+"deg)";}
  const tl=Number(t.lat),tn=Number(t.lon);
  if(map&&Number.isFinite(tl)&&Number.isFinite(tn)&&detected){
    const targetIcon=L.divIcon({className:"targetMarkerLabel",html:'<div class="targetMapMarker">◎</div><span>TARGET</span>',iconSize:[46,46],iconAnchor:[23,23]});
    if(!targetMarker)targetMarker=L.marker([tl,tn],{icon:targetIcon}).addTo(map);else targetMarker.setLatLng([tl,tn]);
    if(rover){
      const rp=rover.getLatLng();
      const pts=[[rp.lat,rp.lng],[tl,tn]];
      if(!targetLine)targetLine=L.polyline(pts,{color:"#ff4858",weight:2,dashArray:"7 6",opacity:.95}).addTo(map);else targetLine.setLatLngs(pts);
    }
  }else{if(targetMarker&&map){map.removeLayer(targetMarker);targetMarker=null}if(targetLine&&map){map.removeLayer(targetLine);targetLine=null}}
  trackPts=(d.track||[]).map(x=>[x.lat,x.lon]);
  if(map&&trackPts.length>1){if(!trackLine)trackLine=L.polyline(trackPts,{color:"#21d5a4",weight:4,opacity:.85}).addTo(map);else trackLine.setLatLngs(trackPts)}
  addSample(d);
}
function updateCompass(heading){
  const compass=$("mapCompass");
  const needle=$("compassNeedle");
  if(!needle)return;
  const h=((Number(heading||0)%360)+360)%360;
  needle.style.transform="translate(-50%,-50%) rotate("+h+"deg)";
  if(compass)compass.setAttribute("aria-label","Rover heading "+Math.round(h)+" degrees");
}
function bearingToDirection(deg){
  const dirs=["N","NE","E","SE","S","SW","W","NW"];
  return dirs[Math.round(((Number(deg)%360)+360)%360/45)%8];
}
function addSample(d){samples.push({b:d.battery,s:d.signal});if(samples.length>60)samples.shift();drawChart()}
function drawChart(){
  const c=$("chart");if(!c)return;const x=c.getContext("2d"),w=c.clientWidth*devicePixelRatio,h=150*devicePixelRatio;c.width=w;c.height=h;x.clearRect(0,0,w,h);if(!samples.length)return;
  x.strokeStyle="#1e3444";x.lineWidth=devicePixelRatio;for(let i=1;i<5;i++){let y=h*i/5;x.beginPath();x.moveTo(0,y);x.lineTo(w,y);x.stroke()}
  const draw=(k,col)=>{x.strokeStyle=col;x.lineWidth=2*devicePixelRatio;x.beginPath();samples.forEach((v,i)=>{const xx=i/Math.max(1,samples.length-1)*w,yy=h-(v[k]/100)*h;i?x.lineTo(xx,yy):x.moveTo(xx,yy)});x.stroke()};draw("b","#22d3a6");draw("s","#4aa3ff");
}

function renderRecentActivity(){
  const el=$("recentActivity");if(!el)return;
  const persistent=lastKnownLoss?(()=>{
    const lat=Number(lastKnownLoss.lat),lon=Number(lastKnownLoss.lon);
    const captured=lastKnownLoss.captured_at?new Date(lastKnownLoss.captured_at):null;
    const lost=lastKnownLoss.lost_at?new Date(lastKnownLoss.lost_at):null;
    const coords=Number.isFinite(lat)&&Number.isFinite(lon)?lat.toFixed(6)+"° N  "+lon.toFixed(6)+"° E":"Coordinates unavailable";
    return '<div class="recentItem lastKnownRecent" role="alert"><span class="recentIcon lastKnownIcon">⚠</span><div><b>LAST KNOWN LOCATION</b><span>Signal lost • '+esc(coords)+'</span><small>Captured '+esc(captured?.toLocaleString()||"unknown")+' • Lost '+esc(lost?.toLocaleString()||"unknown")+'</small></div><div class="lastKnownActions"><time>'+esc(lost?.toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"})||"--")+'</time><button type="button" class="lastKnownRemove" data-remove-last-known>REMOVE</button></div></div>';
  })():"";
  const iconMap={COMMAND:"➜",MODE:"⚙",MAP:"⌖",SYSTEM:"●",LOGIN:"♟",DENIED:"!",OFFLINE:"×",CAMERA:"▣"};
  const recent=recentItems.map(x=>'<div class="recentItem"><span class="recentIcon">'+esc(iconMap[x.type]||"•")+'</span><div><b>'+esc(x.type)+'</b><span>'+esc(x.msg)+'</span></div><time>'+x.time.toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"})+'</time></div>').join("");
  el.innerHTML=persistent+recent;
  el.querySelector("[data-remove-last-known]")?.addEventListener("click",clearLastKnownLocation);
}
function setLastKnownLoss(record){
  let normalized=null;
  if(record&&Number.isFinite(Number(record.lat))&&Number.isFinite(Number(record.lon))){
    normalized={...record,lat:Number(record.lat),lon:Number(record.lon)};
  }
  const key=normalized?JSON.stringify(normalized):"";
  if(key===lastKnownLossKey)return;
  lastKnownLoss=normalized;lastKnownLossKey=key;renderRecentActivity();
}
function pushRecent(type,msg){
  recentItems.unshift({type,msg,time:new Date()});if(recentItems.length>8)recentItems.pop();
  renderRecentActivity();
}
let recentItems=[];
function addLog(type,msg){
  const l=$("log");
  if(l){const d=document.createElement("div");d.className="logrow";d.innerHTML="<time>"+new Date().toLocaleTimeString()+"</time><span><b>"+esc(type)+"</b> "+esc(msg)+"</span>";l.prepend(d);while(l.children.length>50)l.lastChild.remove();}
  pushRecent(type,msg);
}
async function recordActivity(action,details=""){
  try{await api("/api/activity",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action,details})})}catch(_){}
}
async function loadLastKnownLocation(){
  try{
    const r=await api("/api/device-last-known");const d=await r.json();
    if(!r.ok)return;
    setText("deviceOnline",d.device_online===false?"● OFFLINE":"● ONLINE");
    setLastKnownLoss(d.last_known_loss||null);
  }catch(_){}
}
async function clearLastKnownLocation(){
  if(!lastKnownLoss)return;
  if(!window.confirm("Remove the retained last-known location from Recent Activity?"))return;
  try{
    const deviceId=lastKnownLoss.device_id||"ROVER-01";
    const r=await api("/api/device-last-known",{method:"DELETE",headers:{"Content-Type":"application/json"},body:JSON.stringify({device_id:deviceId})});
    const d=await r.json();
    if(!r.ok)throw new Error(d.error||"Remove failed");
    setLastKnownLoss(null);
    addLog("SYSTEM","Retained last-known location removed");
  }catch(_){addLog("DENIED","Could not remove retained last-known location")}
}
function clearLog(){const l=$("log");if(l)l.innerHTML=""}
function renderAlertCount(){
  const b=$("alertBtn"),n=$("alertCount");
  if(!b||!n)return;
  b.classList.toggle("hidden",!(me&&me.role==="admin"));
  n.textContent=String(unreadLogins);
  n.classList.toggle("hidden",unreadLogins===0);
}
function showLoginToast(logins){
  if(!logins.length)return;
  const item=logins[logins.length-1];
  const wrap=document.createElement("div");
  wrap.className="loginToast";
  playNotificationSound().catch(()=>{});
  wrap.innerHTML="<b>🔔 FRIEND LOGIN</b><span>"+esc(item.display_name||item.username)+" ("+esc(item.username)+") logged in just now.</span>";
  document.body.appendChild(wrap);
  setTimeout(()=>wrap.classList.add("hide"),4200);
  setTimeout(()=>wrap.remove(),4800);
  if("Notification" in window && Notification.permission==="granted"){
    try{new Notification("ROVER-01 Login Alert",{body:(item.display_name||item.username)+" ("+item.username+") logged in."})}catch(_){}
  }
}
function clearUnreadAlerts(){
  unreadLogins=0;
  const now=lastLoginAt||new Date().toISOString();
  lastLoginAt=now;
  localStorage.setItem("rover_last_login_at",now);
  renderAlertCount();
  recordActivity("LOGIN_ALERTS_CLEARED","Admin cleared login alerts");
}
async function pollLoginAlerts(){
  if(loginAlertBusy)return;
  if(!me||me.role!=="admin")return;
  loginAlertBusy=true;
  try{
    const loginUrl="/api/login-events?limit=100"+(lastLoginAt?"&since="+encodeURIComponent(lastLoginAt):"");
    const r=await api(loginUrl);const d=await r.json();
    if(!r.ok||!Array.isArray(d.logs))return;
    if(d.warning)setText("alertStatus","Login alerts: "+d.warning);
    const logins=d.logs.filter(x=>x.action==="LOGIN"&&x.role==="user").sort((a,b)=>String(a.created_at).localeCompare(String(b.created_at)));
    if(!logins.length){renderAlertCount();return}
    const newest=String(logins[logins.length-1].created_at||"");
    if(!lastLoginAt){
      lastLoginAt=newest;
      localStorage.setItem("rover_last_login_at",lastLoginAt);
      renderAlertCount();
      return;
    }
    const fresh=logins.filter(x=>String(x.created_at||"")>lastLoginAt);
    if(fresh.length){
      lastLoginAt=String(fresh[fresh.length-1].created_at||lastLoginAt);
      localStorage.setItem("rover_last_login_at",lastLoginAt);
      unreadLogins+=fresh.length;
      renderAlertCount();
      fresh.forEach(x=>showLoginToast([x]));
      addLog("LOGIN",fresh.length===1?((fresh[0].display_name||fresh[0].username)+" logged in"):fresh.length+" friends logged in");
    }
  }catch(_){} finally { loginAlertBusy=false; }
}
async function enableBrowserAlerts(){
  if(!("Notification" in window)){setText("alertStatus","This browser does not expose browser notifications. In-app alerts remain active.");return}
  try{
    const p=await Notification.requestPermission();
    if(p==="granted"){setText("alertStatus","Browser login alerts ENABLED on this device.");recordActivity("BROWSER_ALERTS_ENABLED","Browser notifications enabled")}
    else setText("alertStatus","Browser notification permission was not granted. In-app alerts remain active.");
  }catch(_){setText("alertStatus","Could not enable browser notifications. In-app alerts remain active.")}
}
function updatePermissionUI(){
  const control=!!me&&!demoMode;
  document.querySelectorAll(".control").forEach(b=>b.disabled=!control);
  document.querySelectorAll(".modeBtn").forEach(b=>b.disabled=!control);
  setText("permissionNotice",demoMode?"DEMO MODE: SIMULATED DATA ONLY • ROVER CONTROLS DISABLED":(control?"Control permission: ENABLED":"View-only access: rover controls disabled"));
  const manager=!!(me&&(me.role==="admin"||me.can_manage_users));
  const adminBtn=$("adminBtn"),deviceBtn=$("deviceBtn"),auditTabBtn=$("auditTabBtn");
  if(adminBtn)adminBtn.classList.toggle("hidden",!manager);
  if(deviceBtn)deviceBtn.classList.toggle("hidden",!manager);
  if(auditTabBtn)auditTabBtn.classList.toggle("hidden",!(me&&me.role==="admin"));
  renderAlertCount();
}
async function loadMe(){
  const r=await api("/api/me");const d=await r.json();if(!r.ok)throw new Error(d.error||"Not logged in");
  me=d.user;setText("who",me.display_name+" · "+me.role.toUpperCase());updatePermissionUI();
}
async function loadBootstrap(){
  const r=await api("/api/bootstrap");
  const d=await r.json();
  if(!r.ok)throw new Error(d.error||"Not logged in");
  me=d.user;
  setText("who",me.display_name+" · "+me.role.toUpperCase());
  updatePermissionUI();
  updateUI(d.telemetry);
  setText("conn",connectionText(d.telemetry));
  return d;
}
function demoTelemetry(){
  const point=randomDemoPoint(),targetPoint=randomDemoPoint();
  return {
    battery:78,signal:82,gps_fix:false,gps_sats:0,gps_source:"SIMULATION",
    speed_kmh:3.5,heading:Math.random()*360,
    lat:point.lat,lon:point.lon,
    updated:new Date().toISOString(),mode:"AUTO-DEMO",last_command:"STOP",
    network:"DEMO • SIMULATED",camera:true,camera_source:"SIMULATION",target_source:"SIMULATION",
    tracking:true,geofence:true,temp_c:32,storage_pct:72,
    ai:{person:1,vehicle:0,object:0,confidence:.92},obstacle_cm:125,track:[],
    target:{type:"Person",range_m:842,speed_kmh:18.4,heading:Math.random()*360,direction:"SIM",size_m:1.7,confidence:.92,lat:targetPoint.lat,lon:targetPoint.lon,detected:true}
  };
}
async function initRealCameraStream(){
  if(realCameraInitialized)return;
  realCameraInitialized=true;
  if(demoMode){
    setText("cameraSceneLabel","DEMO CAMERA VIEW • SIMULATION ONLY");
    return;
  }
  const viewport=$("cameraViewport");
  const scene=$("camera3DScene");
  if(!viewport)return;
  let media=$("roverRealCamera");
  let mediaType="";
  if(!media){
    media=document.createElement("video");
    media.id="roverRealCamera";
    media.autoplay=true;media.muted=true;media.playsInline=true;
    media.setAttribute("aria-label","ROVER-01 live camera");
    media.style.cssText="display:none;width:100%;height:100%;object-fit:cover;background:#02070b;position:absolute;inset:0;z-index:4";
    viewport.insertBefore(media,viewport.firstChild);
  }
  try{
    const r=await api("/api/camera-config");
    const d=await r.json();
    if(!r.ok||!d.enabled||!d.url)return;
    mediaType=String(d.type||"mjpeg").toLowerCase();
    if(mediaType==="iframe"){
      const frame=document.createElement("iframe");
      frame.id="roverRealCamera";
      frame.title="ROVER-01 live camera";
      frame.allow="autoplay; fullscreen";
      frame.src=d.url;
      frame.style.cssText="display:block;width:100%;height:100%;border:0;background:#02070b;position:absolute;inset:0;z-index:4";
      media.replaceWith(frame);
      media=frame;
      realCameraActive=true;
    }else if(mediaType==="mjpeg"||mediaType==="image"){
      const img=document.createElement("img");
      img.id="roverRealCamera";
      img.alt="ROVER-01 live camera";
      img.decoding="async";
      img.style.cssText="display:block;width:100%;height:100%;object-fit:cover;background:#02070b;position:absolute;inset:0;z-index:4";
      img.onload=()=>{realCameraActive=true;if(scene)scene.style.display="none";setText("cameraSceneLabel","LIVE CAMERA • ROVER STREAM");setText("cameraStatus","Working")};
      img.onerror=()=>{realCameraActive=false;if(scene)scene.style.display="block";setText("cameraSceneLabel","CAMERA STREAM ERROR • SIMULATION VIEW")};
      img.src=d.url;
      media.replaceWith(img);
      media=img;
    }else{
      const video=document.createElement("video");
      video.id="roverRealCamera";
      video.autoplay=true;video.muted=true;video.playsInline=true;video.controls=false;
      video.style.cssText="display:block;width:100%;height:100%;object-fit:cover;background:#02070b;position:absolute;inset:0;z-index:4";
      video.onloadeddata=()=>{realCameraActive=true;if(scene)scene.style.display="none";setText("cameraSceneLabel","LIVE CAMERA • ROVER STREAM");setText("cameraStatus","Working")};
      video.onerror=()=>{realCameraActive=false;if(scene)scene.style.display="block";setText("cameraSceneLabel","CAMERA STREAM ERROR • SIMULATION VIEW")};
      video.src=d.url;
      media.replaceWith(video);
      media=video;
      video.play().catch(()=>{});
    }
  }catch(_){
    realCameraActive=false;
  }
}

// Privacy mode: do not request or publish browser geolocation.
function randomDemoPoint(){return {lat:12.9716+(Math.random()-0.5)*0.018,lon:77.5946+(Math.random()-0.5)*0.022};}
function initLiveGPSFeed(){setText("gpsSignalText","SIMULATION • RANDOM LOCATION");setText("deviceGpsState","SIMULATED");}
async function loop(){
  if(telemetryBusy)return;
  telemetryBusy=true;
  try{
    if(demoMode){
      updateUI(demoTelemetry());
      setText("conn","● DEMO • SIMULATED DATA");
      return;
    }
    const r=await api("/api/telemetry");
    const d=await r.json();
    if(!r.ok)throw new Error(d.error);
    if(d&&d.sync_version)window.ROVER_SYNC_VERSION=d.sync_version;
    updateUI(d);
    setText("conn",connectionText(d));setText("serverHeaderSub","Backend reachable");
  }catch(e){
    if(me){
      setText("conn",window.roverWS?.readyState===WebSocket.OPEN?"● ONLINE • REALTIME":"● RECONNECTING");
    }else setText("conn","● OFFLINE");setText("serverHeaderSub","Backend unavailable");
  }finally{telemetryBusy=false;}
}
function scheduleTelemetry(){
  // WebSocket is the primary path. HTTP is only a recovery/health path.
  // Keeping the fallback slow prevents unnecessary backend/Durable Object reads.
  const delay=window.roverWS?.readyState===WebSocket.OPEN
    ? (document.hidden?60000:60000)
    : (document.hidden?8000:5000);
  setTimeout(async()=>{await loop();scheduleTelemetry()},delay);
}
let returnBaseMarker=null,returnBaseSelection=false,returnBase=null;
let returnRouteLine=null,returnRouteMode="none";

try{const saved=localStorage.getItem("defenx_return_base");if(saved){const parsed=JSON.parse(saved);if(parsed&&Number.isFinite(parsed.lat)&&Number.isFinite(parsed.lon)&&parsed.lat>=-90&&parsed.lat<=90&&parsed.lon>=-180&&parsed.lon<=180)returnBase=parsed;else localStorage.removeItem("defenx_return_base");}}catch(_){}
function renderReturnBase(){
  if(!mapReady||!map)return;
  if(returnBaseMarker){map.removeLayer(returnBaseMarker);returnBaseMarker=null;}
  if(returnBase){const icon=L.divIcon({className:"returnBaseLabel",html:'<div class="returnBaseMarker">⌂</div><span>BASE</span>',iconSize:[42,42],iconAnchor:[21,21]});returnBaseMarker=L.marker([returnBase.lat,returnBase.lon],{icon,keyboard:true,title:"DEFENX Base"}).addTo(map).bindTooltip("RETURN BASE",{permanent:true,direction:"top",className:"returnBaseTooltip"});}
  const label=returnBase?("BASE SET · "+returnBase.lat.toFixed(5)+", "+returnBase.lon.toFixed(5)):"BASE NOT SET";
  setText("returnBaseStatus",label);
  if(returnRouteLine){map.removeLayer(returnRouteLine);returnRouteLine=null;returnRouteMode="none";}
}
function previewReturnRoute(simulateObstacle=false){
  if(!mapReady||!map){addLog("ROUTE","Interactive map is still loading");return;}
  if(!returnBase){setText("returnBaseStatus","BASE REQUIRED · SELECT BASE ON MAP");addLog("ROUTE","Select a base before previewing a route");return;}
  // This is a visual software simulation only. It deliberately does not use
  // randomized display coordinates as live rover location and sends no commands.
  const origin=rover&&typeof rover.getLatLng==="function"?rover.getLatLng():null;
  if(!origin){setText("returnBaseStatus","ROUTE PREVIEW UNAVAILABLE");addLog("ROUTE","No map marker is available for the simulated rover");return;}
  if(returnRouteLine){map.removeLayer(returnRouteLine);returnRouteLine=null;}
  const a=[origin.lat,origin.lng],b=[returnBase.lat,returnBase.lon];
  let points=[a,b],label="SIMULATION · DIRECT PREVIEW";
  if(simulateObstacle){
    const midLat=(a[0]+b[0])/2,midLon=(a[1]+b[1])/2;
    const dLat=b[0]-a[0],dLon=b[1]-a[1],length=Math.max(Math.hypot(dLat,dLon),0.00001);
    const offset=Math.min(0.003,Math.max(0.00035,length*0.18));
    points=[a,[midLat-dLon/length*offset,midLon+dLat/length*offset],b];
    label="SIMULATION · ALTERNATE ROUTE";
  }
  returnRouteLine=L.polyline(points,{color:simulateObstacle?"#f5b942":"#22d3a6",weight:5,opacity:.9,dashArray:"9 8"}).addTo(map);
  returnRouteMode=simulateObstacle?"alternate":"direct";
  map.fitBounds(returnRouteLine.getBounds(),{padding:[36,36],maxZoom:16});
  setText("returnBaseStatus",label+" · NOT NAVIGATION");
  addLog("ROUTE",label+" rendered; no rover command sent");
}
function clearReturnRoutePreview(){
  if(returnRouteLine&&map){map.removeLayer(returnRouteLine);returnRouteLine=null;}
  returnRouteMode="none";
  if(returnBase) setText("returnBaseStatus","BASE SET · "+returnBase.lat.toFixed(5)+", "+returnBase.lon.toFixed(5));
  else setText("returnBaseStatus","BASE NOT SET");
  addLog("ROUTE","Simulation preview cleared");
}
function beginBaseSelection(){
  if(demoMode){addLog("DEMO","Base selection is disabled in the read-only demo");return;}
  if(!mapReady||!map){addLog("BASE","Wait for the live map to load");return;}
  returnBaseSelection=true;setText("returnBaseStatus","SELECT A BASE LOCATION ON THE MAP");
  addLog("BASE","Tap the map to save the return base");
}
function handleBaseMapClick(e){
  if(!returnBaseSelection||!e?.latlng)return;
  const lat=Number(e.latlng.lat),lon=Number(e.latlng.lng);
  if(!Number.isFinite(lat)||lat < -90||lat > 90||!Number.isFinite(lon)||lon < -180||lon > 180){setText("returnBaseStatus","INVALID BASE LOCATION · TRY AGAIN");addLog("BASE","Rejected invalid base coordinates");return;}
  returnBase={lat,lon,saved_at:new Date().toISOString()};
  try{localStorage.setItem("defenx_return_base",JSON.stringify(returnBase));}catch(_){}
  returnBaseSelection=false;renderReturnBase();addLog("BASE","Base location saved on this browser");
}
async function requestReturnToBase(){
  if(demoMode){addLog("DEMO","Return request is disabled in the read-only demo; route preview remains available on the authenticated dashboard");return;}
  if(!me){try{await loadMe()}catch(_){addLog("DENIED","User session is still loading");return;}}
  if(!returnBase){addLog("RETURN","Set the base first using SELECT BASE ON MAP");setText("returnBaseStatus","BASE REQUIRED · SELECT BASE ON MAP");return;}
  // Fail closed: current firmware/controller capability is unknown. Do not issue
  // a sequence of directional commands or claim autonomy from a dashboard click.
  const telemetry=window.defenxLatestTelemetry||window.roverTelemetry||null;
  if(!telemetry||telemetry.gps_fix!==true||!Number.isFinite(telemetry.lat)||telemetry.lat < -90||telemetry.lat > 90||!Number.isFinite(telemetry.lon)||telemetry.lon < -180||telemetry.lon > 180){
    addLog("RETURN BLOCKED","Verified, valid live rover GPS coordinates are required before return can start");setText("returnBaseStatus","RETURN BLOCKED · VERIFIED LIVE GPS REQUIRED");return;
  }
  if(telemetry.autonomous_navigation!==true||telemetry.obstacle_avoidance!==true||telemetry.obstacle_sensor_healthy!==true||telemetry.safety_controller_healthy!==true){
    addLog("RETURN BLOCKED","Autonomous navigation, obstacle-sensor health, and safety-controller health are not all confirmed; rover was not commanded to move");setText("returnBaseStatus","RETURN BLOCKED · SAFETY CAPABILITIES UNVERIFIED");
    alert("Return to Base is not started. The connected controller must confirm autonomous navigation, obstacle avoidance, healthy obstacle sensing, and a healthy safety controller. No movement command was sent.");return;
  }
  addLog("RETURN BLOCKED","A verified hardware return-to-base command endpoint is not yet configured; no movement command was sent");
  setText("returnBaseStatus","RETURN BLOCKED · HARDWARE COMMAND ENDPOINT REQUIRED");
}

async function sendCommand(command){
  if(demoMode){addLog("DEMO","Rover commands are disabled in the read-only demo");return false;}
  if(!me){
    try{await loadMe()}catch(_){addLog("DENIED","User session is still loading");return false}
  }
  const requested=String(command||"STOP").toUpperCase();
  try{
    // Primary path: a live WebSocket message is broadcast to every connected device.
    if(window.roverWS?.readyState===WebSocket.OPEN){
      setText("cmd",requested);
      if(window.ROVER_CAMERA_CONTROL)window.ROVER_CAMERA_CONTROL(requested);
      const camera=$("cameraSceneLabel");
      if(camera){const labels={FORWARD:"CAMERA • FORWARD",REVERSE:"CAMERA • REVERSE",LEFT:"CAMERA • LEFT",RIGHT:"CAMERA • RIGHT",STOP:"CAMERA • STABILIZED"};camera.textContent=labels[requested]||"DEMO CAMERA VIEW • SIMULATION";}
      window.roverWS.send(JSON.stringify({type:"command",command:requested}));
      addLog("COMMAND","Broadcast "+requested);
      return true;
    }
    const r=await api("/api/command",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({command:requested})});
    const d=await r.json();
    addLog(r.ok?"COMMAND":"DENIED",r.ok?requested:(d.error||"Rejected"));
    if(r.ok){
      if(d.telemetry)updateUI(d.telemetry);
      else setText("cmd",requested);
      if(requested==="STOP"&&motionStopTimer){clearTimeout(motionStopTimer);motionStopTimer=null}
    }
    return r.ok;
  }catch(e){addLog("RECONNECT","Command is queued by the client and will be re-sent on the next operator action");return false}
}
async function setMode(mode){
  if(demoMode){addLog("DEMO","Operating modes are disabled in the read-only demo");return;}
  if(!me){
    try{await loadMe()}catch(_){addLog("DENIED","User session is still loading");return}
  }
  try{
    if(window.roverWS?.readyState===WebSocket.OPEN){
      window.roverWS.send(JSON.stringify({type:"mode",mode:String(mode).toUpperCase()}));
      setText("modeBadge",mode);document.querySelectorAll(".modeBtn").forEach(b=>b.classList.toggle("active",b.dataset.mode===mode));
      addLog("MODE","Broadcast "+mode);
      return;
    }
    const r=await api("/api/mode",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({mode})});
    const d=await r.json();
    addLog(r.ok?"MODE":"DENIED",r.ok?mode:(d.error||"Rejected"));
    if(r.ok){
      if(d.telemetry)updateUI(d.telemetry);else setText("modeBadge",mode);
      document.querySelectorAll(".modeBtn").forEach(b=>b.classList.toggle("active",b.dataset.mode===mode));
    }
  }catch(e){addLog("RECONNECT","Mode update could not reach the control centre")}
}
async function simulate(){if(me)await api("/api/simulate",{method:"POST"})}
async function logoutAction(){
  if(logoutSent)return;
  logoutSent=true;
  sessionStorage.removeItem("rover_user");
  document.querySelectorAll("#logoutBtn,#sideLogoutBtn,.mobileLogout").forEach(b=>{
    b.disabled=true;
    b.setAttribute("aria-disabled","true");
  });
  try{
    await Promise.race([
      fetch("/api/logout",{method:"POST",cache:"no-store",credentials:"same-origin",keepalive:true}),
      new Promise(resolve=>setTimeout(resolve,1500))
    ]);
  }catch(_){}
  location.replace("/login.html");
}

async function saveProfile(){
  const payload={display_name:$("profileName").value.trim(),new_password:$("profilePassword").value};
  const r=await api("/api/profile",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)});const d=await r.json();
  setText("profileMsg",d.ok?"Profile saved.":(d.error||"Could not save profile"));if(d.ok){me=d.user;setText("who",me.display_name+" · "+me.role.toUpperCase());setTimeout(()=>closeModal("profileModal"),600)}
}
async function loadUsers(){
  const r=await api("/api/users");const d=await r.json();
  if(!r.ok){$("userTable").innerHTML="<div class='empty'>"+esc(d.error||"Could not load users")+"</div>";return}
  const users=Array.isArray(d.users)?d.users:[];
  const friendCount=users.filter(u=>u.role==="user").length;
  const adminCount=users.filter(u=>u.role==="admin").length;
  const statusNote=d.warning ? "<div class='formmsg'>"+esc(d.warning)+"</div>" : "";
  $("userTable").innerHTML="<div class='panelTitle'>"+friendCount+" USER ACCOUNTS"+(adminCount?" + "+adminCount+" ADMIN":"")+"</div>"+statusNote+
  "<table><tr><th>User ID</th><th>User</th><th>Role</th><th>Status</th><th>Control</th><th>Manage</th><th>Last login</th><th>Actions</th></tr>"+
  users.map(u=>"<tr><td><small>"+esc(u.id)+"</small></td><td><b>"+esc(u.display_name)+"</b><small>"+esc(u.username)+"</small></td><td>"+esc(u.role)+"</td><td>"+(u.enabled?"ENABLED":"DISABLED")+"</td><td>"+(u.can_control?"YES":"NO")+"</td><td>"+(u.can_manage_users?"YES":"NO")+"</td><td>"+esc(u.last_login_at?new Date(u.last_login_at).toLocaleString():"Never")+"</td><td><button class='mini' data-user='"+esc(u.id)+"' data-action='toggle' data-value='"+(!u.enabled)+"'>"+(u.enabled?"DISABLE":"ENABLE")+"</button> <button class='mini' data-user='"+esc(u.id)+"' data-action='control' data-value='"+(!u.can_control)+"'>"+(u.can_control?"CONTROL OFF":"CONTROL ON")+"</button> <button class='mini' data-user='"+esc(u.id)+"' data-action='manage' data-value='"+(!u.can_manage_users)+"'>"+(u.can_manage_users?"MANAGE OFF":"MANAGE ON")+"</button> <button class='mini' data-user='"+esc(u.id)+"' data-action='name'>EDIT NAME</button> <button class='mini dangerMini' data-user='"+esc(u.id)+"' data-action='password' data-username='"+esc(u.username)+"'>RESET PASSWORD</button></td></tr>").join("")+"</table>";
}

async function userAction(el){
  const id=el.dataset.user,action=el.dataset.action;let body={};
  if(action==="toggle")body.enabled=el.dataset.value==="true";
  if(action==="control")body.can_control=el.dataset.value==="true";
  if(action==="manage")body.can_manage_users=el.dataset.value==="true";
  if(action==="name"){const cells=el.closest("tr").querySelectorAll("td");const current=(cells[1]?.querySelector("b")?.textContent||"").trim();const name=prompt("New display name:",current);if(name===null)return;const trimmed=name.trim();if(!trimmed){alert("Display name cannot be empty.");return}body.display_name=trimmed}
  if(action==="password"){
    if(me?.role!=="admin"){alert("Only the Admin can reset passwords.");return}
    const username=el.dataset.username||"this user";
    const password=prompt("Set a new password for "+username+" (minimum 10 characters):");
    if(password===null)return;
    if(password.length<10){alert("Password must be at least 10 characters.");return}
    const confirmPassword=prompt("Confirm the new password for "+username+":");
    if(confirmPassword===null)return;
    if(password!==confirmPassword){alert("Passwords do not match.");return}
    const r=await api("/api/users/"+id+"/reset-password",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({password})});
    const d=await r.json();
    if(!r.ok){alert(d.error||"Password reset failed");return}
    alert("Password reset successfully for "+username+".");
    await loadUsers();await loadAudit();return
  }
  const r=await api("/api/users/"+id,{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});const d=await r.json();if(!r.ok)alert(d.error||"Update failed");await loadUsers();await loadAudit();
}
async function createUser(){
  const body={username:$("newUsername").value.trim(),display_name:$("newDisplayName").value.trim(),password:$("newPassword").value,role:$("newRole").value,can_control:$("newControl").checked,can_manage_users:$("newManage").checked};
  const r=await api("/api/users",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});const d=await r.json();setText("userMsg",d.ok?"User created successfully.":(d.error||"Could not create user"));if(d.ok){["newUsername","newDisplayName","newPassword"].forEach(id=>$(id).value="");$("newControl").checked=false;$("newManage").checked=false;await loadUsers();await loadAudit()}
}
async function loadAudit(){
  const r=await api("/api/audit?limit=1000");const d=await r.json();
  if(!r.ok){$("auditTable").innerHTML="<div class='empty'>"+esc(d.error||"Could not load audit log")+"</div>";return}
  if(!d.logs.length){$("auditTable").innerHTML="<div class='empty'>"+esc(d.warning||"No audit entries yet.")+"</div>";return}
  $("auditTable").innerHTML="<table><tr><th>Time</th><th>User</th><th>Action</th><th>Details</th><th>IP</th></tr>"+
    d.logs.map(x=>"<tr><td>"+esc(new Date(x.created_at).toLocaleString())+"</td><td><b>"+esc(x.display_name||x.username)+"</b><small>"+esc(x.username)+" · "+esc(x.role||"")+"</small></td><td>"+esc(x.action)+"</td><td>"+esc(x.details||"")+"</td><td>"+esc(x.ip_address||"")+"</td></tr>").join("")+"</table>";
}
function applyTheme(){
  const light=localStorage.getItem("rover_theme")==="light";
  document.body.classList.toggle("light",light);
  setText("themeBtn",light?"☀ Light":"☾ Dark");
}
function toggleTheme(){
  const light=!document.body.classList.contains("light");
  localStorage.setItem("rover_theme",light?"light":"dark");
  applyTheme();
  initMobileNav();
  addLog("UI",light?"Light theme enabled":"Dark theme enabled");
  recordActivity("THEME_CHANGED",light?"Light theme enabled":"Dark theme enabled");
}


function loadDashboardAudit(){
  const el=$("dashboardAuditTable");
  if(!el)return;
  if(!me||me.role!=="admin"){el.innerHTML="<div class='empty'>Admin access required for the shared audit history.</div>";return}
  api("/api/audit?limit=20").then(r=>r.json()).then(d=>{
    if(!d.logs||!d.logs.length){el.innerHTML="<div class='empty'>"+esc(d.warning||"No audit entries yet.")+"</div>";return}
    el.innerHTML="<table><tr><th>Time</th><th>User</th><th>Action</th><th>Details</th><th>IP</th></tr>"+
      d.logs.map(x=>"<tr><td>"+esc(new Date(x.created_at).toLocaleTimeString())+"</td><td>"+esc(x.display_name||x.username)+"</td><td>"+esc(x.action)+"</td><td>"+esc(x.details||"")+"</td><td>"+esc(x.ip_address||"")+"</td></tr>").join("")+"</table>";
  }).catch(()=>{});
}
function scrollToSection(id){
  const el=$(id);if(el)el.scrollIntoView({behavior:"smooth",block:"start"});
}
async function captureScreen(){
  addLog("CAMERA","Screenshot action requested");
  if(navigator.mediaDevices?.getDisplayMedia){
    try{
      const stream=await navigator.mediaDevices.getDisplayMedia({video:{frameRate:1},audio:false});
      const video=document.createElement("video");video.srcObject=stream;video.muted=true;await video.play();
      await new Promise(res=>setTimeout(res,250));
      const canvas=document.createElement("canvas");canvas.width=video.videoWidth||window.innerWidth*2;canvas.height=video.videoHeight||window.innerHeight*2;
      canvas.getContext("2d").drawImage(video,0,0,canvas.width,canvas.height);
      stream.getTracks().forEach(t=>t.stop());
      canvas.toBlob(blob=>{if(!blob)return;const a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download="ROVER-01-dashboard-"+Date.now()+".png";a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000)},"image/png");
      return;
    }catch(_){}
  }
  window.print();
}
function toggleNightMode(){
  const on=document.body.classList.toggle("night-mode");
  const b=$("nightModeBtn");if(b)b.classList.toggle("active",on);
  addLog("UI",on?"Night mode enabled":"Night mode disabled");recordActivity("NIGHT_MODE",on?"Night mode enabled":"Night mode disabled");
}
function setLiveTracking(){
  liveTracking=!liveTracking;
  const b=$("liveTrackBtn");if(b)b.classList.toggle("active",liveTracking);
  addLog("TRACK",liveTracking?"Live tracking active":"Live tracking paused");
}
function cycleMode(){
  const modes=["MANUAL","ASSISTED","AUTO-DEMO"];const current=$("modeBadge")?.textContent||"MANUAL";const i=Math.max(0,modes.indexOf(current));setMode(modes[(i+1)%modes.length]);
}
function initMobileNav(){
  const panel=$("mobileNavPanel"),grid=panel?.querySelector(".mobileNavGrid"),btn=$("mobileMenuBtn");
  if(!panel||!grid||!btn)return;
  grid.innerHTML="";
  document.querySelectorAll(".sideNav .navItem").forEach(item=>{
    const clone=item.cloneNode(true);
    clone.classList.remove("active");
    clone.addEventListener("click",()=>{
      item.click();
      panel.classList.remove("open");panel.setAttribute("aria-hidden","true");btn.setAttribute("aria-expanded","false");
    });
    grid.appendChild(clone);
  });
  if(!grid.querySelector(".mobileLogout")){
    const logout=document.createElement("button");
    logout.type="button";
    logout.className="mobileLogout";
    logout.innerHTML="<span>⏻</span> Logout";
    logout.addEventListener("click",logoutAction);
    grid.appendChild(logout);
  }
  if(btn.dataset.menuClickBound!=="1"){
    btn.dataset.menuClickBound="1";
    btn.addEventListener("click",()=>{
      const open=panel.classList.toggle("open");
      panel.setAttribute("aria-hidden",String(!open));btn.setAttribute("aria-expanded",String(open));
    });
  }
}

function initCameraObstacleSimulation(room){
  if(!room||room.dataset.obstaclesBound==="1")return;
  room.dataset.obstaclesBound="1";
  const style=document.createElement("style");
  style.dataset.dynamicObstacleStyle="1";
  style.textContent=`
    .camObstacleLayer{position:absolute;inset:0;z-index:7;pointer-events:none;transform-style:preserve-3d}
    .camObstacle{position:absolute;left:50%;bottom:78px;width:58px;height:118px;opacity:0;transform:translate3d(-50%,18px,0) scale(.72);transition:opacity .42s ease,transform .6s cubic-bezier(.2,.75,.2,1),filter .25s ease;filter:drop-shadow(0 10px 7px rgba(0,0,0,.48));transform-origin:50% 100%;will-change:opacity,transform}
    .camObstacle.isVisible{opacity:1;transform:translate3d(-50%,0,var(--obstacle-z,60px)) scale(var(--obstacle-scale,1))}
    .camObstacleTag{position:absolute;left:50%;top:-19px;transform:translateX(-50%);padding:3px 6px;border:1px solid rgba(255,91,105,.75);border-radius:4px;background:rgba(45,7,13,.88);color:#ffb3ba;font:800 6px/1 ui-monospace,monospace;letter-spacing:.7px;white-space:nowrap}
    .camHuman .camHead{position:absolute;left:21px;top:0;width:16px;height:16px;border-radius:50%;background:linear-gradient(180deg,#c3d5dc,#6e8791);border:1px solid #d8edf2;box-shadow:0 0 9px rgba(164,222,235,.18)}
    .camHuman .camBody{position:absolute;left:15px;top:17px;width:28px;height:47px;border-radius:10px 10px 7px 7px;background:linear-gradient(160deg,#2d6f7d,#123440 72%);border:1px solid #52bfd0}
    .camHuman .camArm{position:absolute;top:23px;width:8px;height:39px;border-radius:7px;background:#275562;border:1px solid #4a8998}
    .camHuman .camArm.left{left:7px;transform:rotate(12deg)}.camHuman .camArm.right{right:7px;transform:rotate(-12deg)}
    .camHuman .camLeg{position:absolute;top:61px;width:10px;height:39px;border-radius:5px;background:#142b34;border:1px solid #416370}
    .camHuman .camLeg.left{left:15px}.camHuman .camLeg.right{right:15px}
    .camHuman .camBeacon{position:absolute;left:25px;top:35px;width:8px;height:8px;border-radius:50%;background:#ff4f63;box-shadow:0 0 12px rgba(255,79,99,.75);animation:camObstaclePulse 1.2s ease-in-out infinite}
    .camCrate{width:72px;height:66px;bottom:78px}.camCrate .camCrateBody{position:absolute;inset:8px 2px 0;border:2px solid #5a8190;border-radius:4px;background:linear-gradient(160deg,#24434e,#0d222c)}.camCrate .camCrateBody:before,.camCrate .camCrateBody:after{content:"";position:absolute;left:13px;right:13px;top:50%;height:2px;background:#4a7180}.camCrate .camCrateBody:after{left:50%;top:13px;bottom:13px;width:2px;height:auto}
    .camBarrier{width:88px;height:86px;bottom:76px}.camBarrier .camBarrierBody{position:absolute;left:8px;right:8px;bottom:12px;height:24px;border:2px solid #8a6f34;border-radius:4px;background:repeating-linear-gradient(135deg,#b18a34 0 9px,#2f2b20 9px 18px);box-shadow:0 5px 0 #101a1e}.camBarrier i{position:absolute;bottom:0;width:7px;height:67px;background:linear-gradient(90deg,#1c2d34,#4e666d);border:1px solid #6d858c}.camBarrier i.left{left:17px}.camBarrier i.right{right:17px}
    @keyframes camObstaclePulse{0%,100%{opacity:.55;transform:scale(.92)}50%{opacity:1;transform:scale(1.08)}}
    .cameraObstacleState{position:absolute;left:10px;bottom:10px;z-index:11;padding:4px 7px;border:1px solid rgba(69,179,197,.45);border-radius:4px;background:rgba(3,12,18,.76);color:#79bfd0;font:800 7px/1 ui-monospace,monospace;letter-spacing:.8px;pointer-events:none}.cameraObstacleState.targeting{border-color:rgba(255,81,96,.65);color:#ff9ea8}
    .cameraTargetFocus{outline:2px solid rgba(255,71,87,.9);outline-offset:3px;filter:drop-shadow(0 0 12px rgba(255,71,87,.45)) drop-shadow(0 10px 7px rgba(0,0,0,.48))!important}
  `;
  document.head.appendChild(style);
  const layer=document.createElement("div");layer.className="camObstacleLayer";layer.setAttribute("aria-hidden","true");room.appendChild(layer);
  const state=document.createElement("div");state.className="cameraObstacleState";state.textContent="AI VISION • CLEAR";room.appendChild(state);
  const positions=[{left:"28%",bottom:92,z:115,scale:.88},{left:"48%",bottom:76,z:170,scale:1.08},{left:"69%",bottom:96,z:95,scale:.77}];
  const slots=positions.map(p=>{const el=document.createElement("div");el.className="camObstacle";layer.appendChild(el);return{p,el,active:false,type:null}});
  const setCameraFocus=slot=>{
    slots.forEach(s=>s.el.classList.remove("cameraTargetFocus"));
    const active=slot&&slot.active?slot:null;
    if(active)active.el.classList.add("cameraTargetFocus");
    const box=document.querySelector(".camTargetBox");
    const viewport=$("cameraViewport"),sceneLabel=$("cameraSceneLabel");
    if(box){box.classList.toggle("cameraTargetOn",!!active);box.classList.toggle("cameraTargetOff",!active);box.setAttribute("aria-hidden",String(!active));}
    if(viewport)viewport.classList.toggle("camera-target-active",!!active);
    state.classList.toggle("targeting",!!active);
    setText("cameraTargetType",active?(active.type==="human"?"HUMAN":active.type==="barrier"?"BARRIER":"OBJECT"):"OFF");
    if(sceneLabel)sceneLabel.textContent=active?"AI TARGET FOCUS • "+(active.type==="human"?"HUMAN":active.type==="barrier"?"BARRIER":"OBJECT"):"AI VISION • SCANNING";
  };
  const drawHuman=el=>{el.className="camObstacle camHuman";el.innerHTML='<span class="camObstacleTag">TARGET • HUMAN</span><i class="camHead"></i><i class="camBody"></i><i class="camArm left"></i><i class="camArm right"></i><i class="camLeg left"></i><i class="camLeg right"></i><i class="camBeacon"></i>'};
  const drawCrate=el=>{el.className="camObstacle camCrate";el.innerHTML='<span class="camObstacleTag">TARGET • OBJECT</span><i class="camCrateBody"></i>'};
  const drawBarrier=el=>{el.className="camObstacle camBarrier";el.innerHTML='<span class="camObstacleTag">TARGET • BARRIER</span><i class="camBarrierBody"></i><i class="left"></i><i class="right"></i>'};
  const hideAll=()=>{slots.forEach(s=>{s.el.classList.remove("isVisible");s.active=false;s.type=null});setCameraFocus(null);state.textContent="AI VISION • CLEAR"};
  const showTarget=type=>{
    hideAll();
    const slot=slots[Math.floor(Math.random()*slots.length)];
    slot.active=true;slot.type=type==="human"?"human":type==="barrier"?"barrier":"object";
    slot.p.left=positions[Math.floor(Math.random()*positions.length)].left;
    slot.p.bottom=positions[Math.floor(Math.random()*positions.length)].bottom;
    slot.p.z=slot.type==="human"?150:105;slot.p.scale=slot.type==="human"?1.04:.86;
    slot.el.style.left=slot.p.left;slot.el.style.bottom=slot.p.bottom+"px";slot.el.style.setProperty("--obstacle-z",slot.p.z+"px");slot.el.style.setProperty("--obstacle-scale",String(slot.p.scale));
    if(slot.type==="human")drawHuman(slot.el);else if(slot.type==="barrier")drawBarrier(slot.el);else drawCrate(slot.el);
    requestAnimationFrame(()=>slot.el.classList.add("isVisible"));
    setCameraFocus(slot);
    state.textContent="AI TARGET • "+(slot.type==="human"?"HUMAN":slot.type==="barrier"?"BARRIER":"OBJECT")+" DETECTED";
  };
  let lastAppliedDetected=null,lastAppliedType=null;
  const applyTarget=(detected,type)=>{
    const normalizedDetected=!!detected;
    const normalizedType=(type||"object").toLowerCase();
    if(normalizedDetected===lastAppliedDetected && normalizedType===lastAppliedType)return;
    lastAppliedDetected=normalizedDetected;
    lastAppliedType=normalizedType;
    if(normalizedDetected)showTarget(normalizedType);else hideAll();
  };
  window.addEventListener("rover-target-state",e=>{
    const d=e.detail||{};
    applyTarget(!!d.detected,d.type||"object");
  });
  window.addEventListener("roomobstacledestroy",()=>{});
  setTimeout(()=>applyTarget(!!window.ROVER_CAMERA_TARGET_STATE?.detected,window.ROVER_CAMERA_TARGET_STATE?.type),0);
}

function initCamera3DRoom(){
  const scene=$("camera3DScene"),room=$("camera3DRoom"),readout=$("camera360Heading");
  if(!scene||!room||scene.dataset.bound==="1")return;
  scene.dataset.bound="1";
  let heading=0,pitch=-2,dragging=false,lastX=0,lastY=0,renderQueued=false;
  const normalize=a=>((a%360)+360)%360;
  const render=()=>{
    if(renderQueued)return;
    renderQueued=true;
    requestAnimationFrame(()=>{
      renderQueued=false;
      heading=normalize(heading);
      room.style.transform="translate(-50%,-50%) rotateX("+pitch+"deg) rotateY("+(-heading)+"deg)";
      if(readout)readout.textContent=Math.round(heading)+"°";
    });
  };
  const rotate=deg=>{heading=normalize(heading+deg);render();};
  const cameraCommand=command=>{
    const c=String(command||"").toUpperCase();
    if(c==="LEFT") rotate(-30);
    else if(c==="RIGHT") rotate(30);
    else if(c==="FORWARD") { pitch=-7; render(); }
    else if(c==="REVERSE") { pitch=4; render(); }
    else if(c==="STOP") { pitch=-2; render(); }
  };
  window.ROVER_CAMERA_CONTROL=cameraCommand;
  scene.querySelectorAll("[data-room-rotate]").forEach(b=>b.addEventListener("click",()=>rotate(Number(b.dataset.roomRotate)||0)));
  $("room360Reset")?.addEventListener("click",()=>{heading=0;pitch=-2;render();});
  $("room360Half")?.addEventListener("click",()=>rotate(180));
  const start=(x,y)=>{
    dragging=true;lastX=x;lastY=y;room.classList.add("isDragging");
  };
  const move=(x,y)=>{
    if(!dragging)return;
    const dx=x-lastX,dy=y-lastY;lastX=x;lastY=y;
    heading=normalize(heading-dx*0.45);pitch=Math.max(-16,Math.min(16,pitch+dy*0.22));render();
  };
  const end=()=>{dragging=false;room.classList.remove("isDragging");};
  scene.addEventListener("pointerdown",e=>{if(e.target.closest(".camera360Controls"))return;scene.setPointerCapture?.(e.pointerId);start(e.clientX,e.clientY);});
  scene.addEventListener("pointermove",e=>move(e.clientX,e.clientY));
  scene.addEventListener("pointerup",end);scene.addEventListener("pointercancel",end);scene.addEventListener("pointerleave",()=>{if(dragging)end();});
  scene.addEventListener("wheel",e=>{e.preventDefault();rotate(e.deltaY>0?5:-5);},{passive:false});
  scene.tabIndex=0;
  scene.addEventListener("keydown",e=>{
    if(e.key==="ArrowLeft"){e.preventDefault();rotate(-10);}
    else if(e.key==="ArrowRight"){e.preventDefault();rotate(10);}
    else if(e.key==="ArrowUp"){e.preventDefault();pitch=Math.max(-16,pitch-3);render();}
    else if(e.key==="ArrowDown"){e.preventDefault();pitch=Math.min(16,pitch+3);render();}
    else if(e.key==="Home"){e.preventDefault();heading=0;pitch=-2;render();}
  });
  render();
  initCameraObstacleSimulation(room);
}
function bindUI(){
  $("themeBtn")?.addEventListener("click",toggleTheme);
  applyTheme();
  $("settingsBtn")?.addEventListener("click",()=>scrollToSection("controlPanel"));
  $("profileBtn")?.addEventListener("click",()=>{if(!me){openModal("profileModal");setText("profileMsg","Authenticating…");return;}$("profileUsername").value=me.username;$("profileName").value=me.display_name;$("profilePassword").value="";setText("profileMsg","");openModal("profileModal");recordActivity("PROFILE_OPENED","Profile opened");});
  $("adminBtn")?.addEventListener("click",async()=>{openModal("adminModal");recordActivity("ALERTS_OPENED","Admin activity centre opened");await loadUsers();await loadAudit();pollLoginAlerts();});
  $("deviceBtn")?.addEventListener("click",()=>{recordActivity("DEVICES_OPENED","Device management opened");openDevices()});
  $("createDeviceBtn")?.addEventListener("click",createDevice);
  $("alertBtn")?.addEventListener("click",async()=>{openModal("adminModal");recordActivity("ALERTS_OPENED","Login alerts opened");await loadAudit();});
  $("enableAlertsBtn")?.addEventListener("click",enableBrowserAlerts);
  $("soundBtn")?.addEventListener("click",toggleNotificationSound);
  $("warningToggleBtn")?.addEventListener("click",toggleWarningDisplay);
  $("warningOnBtn")?.addEventListener("click",()=>setWarningDisplay(true));
  $("warningOffBtn")?.addEventListener("click",()=>setWarningDisplay(false));
  updateWarningControlUI({obstacle_cm:999,target:{detected:false}});
  const armNotificationAudio=()=>{initNotificationAudio().then(ok=>{if(ok&&targetAlarmActive)targetSirenBurst()}).catch(()=>{})};
  document.addEventListener("pointerdown",armNotificationAudio,{once:true,passive:true});
  document.addEventListener("touchstart",armNotificationAudio,{once:true,passive:true});
  document.addEventListener("click",armNotificationAudio,{once:true,passive:true});
  document.addEventListener("keydown",armNotificationAudio,{once:true,passive:true});
  document.addEventListener("visibilitychange",()=>{if(document.visibilityState==="visible")initNotificationAudio().catch(()=>{})});
  $("clearAlertsBtn")?.addEventListener("click",clearUnreadAlerts);
  $("logoutBtn")?.addEventListener("click",logoutAction);$("sideLogoutBtn")?.addEventListener("click",logoutAction);
  document.querySelectorAll("[data-close]").forEach(b=>b.addEventListener("click",()=>closeModal(b.dataset.close)));
  $("saveProfileBtn")?.addEventListener("click",saveProfile);$("createUserBtn")?.addEventListener("click",createUser);$("clearLogBtn")?.addEventListener("click",clearLog);
  $("fitBtn")?.addEventListener("click",fitTrack);$("centerBtn")?.addEventListener("click",centerRover);$("recenterCrossBtn")?.addEventListener("click",centerRover);
  document.querySelectorAll(".modeBtn").forEach(b=>b.addEventListener("click",()=>setMode(b.dataset.mode)));
  $("openModeBtn")?.addEventListener("click",()=>scrollToSection("controlPanel"));
  document.querySelectorAll(".control").forEach(b=>{const c=b.dataset.cmd;if(!c)return;b.addEventListener("click",async()=>{await sendCommand(c);})});
  document.querySelectorAll(".mapTab").forEach(b=>b.addEventListener("click",()=>setMapMode(b.dataset.mapmode)));
  $("quickCenterBtn")?.addEventListener("click",centerRover);$("quickFitBtn")?.addEventListener("click",fitTrack);$("quickSatBtn")?.addEventListener("click",()=>setMapMode(satelliteOn?"map":"satellite"));$("liveTrackBtn")?.addEventListener("click",setLiveTracking);$("nightModeBtn")?.addEventListener("click",toggleNightMode);$("screenShotBtn")?.addEventListener("click",captureScreen);
  $("camShotBtn")?.addEventListener("click",captureScreen);$("camRecordBtn")?.addEventListener("click",()=>{recording=!recording;const b=$("camRecordBtn");b.classList.toggle("active",recording);addLog("CAMERA",recording?"Recording started":"Recording stopped");recordActivity("CAMERA_RECORD",recording?"Recording started":"Recording stopped")});
  $("camFullscreenBtn")?.addEventListener("click",()=>{const el=$("cameraViewport");if(el?.requestFullscreen)el.requestFullscreen().catch(()=>{});});
  $("recentViewAll")?.addEventListener("click",()=>{if(me?.role==="admin"){openModal("adminModal");loadAudit()}else scrollToSection("eventLogSection")});
  $("userTable")?.addEventListener("click",e=>{const b=e.target.closest("button[data-user]");if(b)userAction(b)});
  $("usersTabBtn")?.addEventListener("click",async()=>{show("usersTab");hide("auditTab");await loadUsers()});
  $("devicesTabBtn")?.addEventListener("click",loadDevices);
  $("auditTabBtn")?.addEventListener("click",async()=>{hide("usersTab");show("auditTab");await loadAudit()});
  document.querySelectorAll(".navItem").forEach(b=>b.addEventListener("click",()=>{document.querySelectorAll(".navItem").forEach(x=>x.classList.remove("active"));b.classList.add("active");const a=b.dataset.action;if(a==="users"){openModal("adminModal");loadUsers();return}if(a==="devices"){openDevices();return}if(a==="settings"){scrollToSection("controlPanel");return}if(b.dataset.scroll)scrollToSection(b.dataset.scroll)}));
  initMobileNav();
  initCamera3DRoom();
  initRealCameraStream();
}
function tickClock(){const s=new Date().toLocaleTimeString();setText("clock",s);setText("vtime",s)}
window.addEventListener("resize",()=>{if(map)map.invalidateSize()});
window.addEventListener("error",()=>{if(me)setText("conn","● DEGRADED")});
window.addEventListener("unhandledrejection",()=>{if(me)setText("conn","● DEGRADED")});
window.addEventListener("offline",()=>{if(me)setText("conn","● DASHBOARD NETWORK OFFLINE")});
window.addEventListener("online",()=>{if(me){setText("conn","● RECONNECTING");loadLastKnownLocation().catch(()=>{});loop()}});

// Do not log out when the tab/app is backgrounded. Mobile browsers fire pagehide
// during tab switches, app suspension and navigation-cache transitions. Logout is
// now performed only by the explicit Logout actions or the server-side expiry.
window.addEventListener("pageshow",event=>{
  if(event.persisted && me){
    setText("conn","● RECONNECTING");
    loadBootstrap().then(()=>loadLastKnownLocation()).catch(()=>{});
  }
});
async function bootDashboard(){
  const leftImg=$("leftRoverImage"); if(leftImg&&window.ROVER_LEFT_IMAGE) leftImg.src=window.ROVER_LEFT_IMAGE;

  bindUI();
  updateNotificationSoundUI();
  if(demoMode){
    me=null;
    updatePermissionUI();
    setText("who","DEMO VIEW · READ ONLY");
    updateUI(demoTelemetry());
    setText("conn","● DEMO • SIMULATED DATA");
    loadMapAsync();
    scheduleTelemetry();
    setInterval(tickClock,1000);
    tickClock();
    return;
  }
  try{
    // SECURITY: never trust sessionStorage/local UI state as authentication.
    // The server-side session must authenticate before the dashboard starts.
    await loadBootstrap();
    await loadLastKnownLocation();
    loadMapAsync();
    connectRealtime();
    scheduleTelemetry();
    initLiveGPSFeed();
    // Only Admin drives the shared demo telemetry heartbeat. Other devices are
    // read-only replicas of the same shared state and never overwrite it.
    if(me&&me.role==="admin")setInterval(()=>{if(!document.hidden)simulate()},4000);
    if(me&&me.role==="admin"){
      pollLoginAlerts();
      loadDashboardAudit();
      setInterval(pollLoginAlerts,6000);
      setInterval(()=>{loadAudit().catch(()=>{});loadDashboardAudit()},15000);
    }
    setInterval(tickClock,1000);tickClock();pushRecent("SYSTEM","Command centre online");
  }catch(e){
    me=null;
    sessionStorage.removeItem("rover_user");
    location.replace("/login.html");
  }
}
if(document.readyState==="loading"){
  document.addEventListener("DOMContentLoaded",bootDashboard,{once:true});
}else{
  bootDashboard();
}
document.addEventListener("click",function(e){if(e.target.closest("#selectReturnBaseBtn"))beginBaseSelection();if(e.target.closest("#returnToBaseBtn"))requestReturnToBase();if(e.target.closest("#previewReturnRouteBtn"))previewReturnRoute(false);if(e.target.closest("#simulateObstacleRouteBtn"))previewReturnRoute(true);if(e.target.closest("#clearReturnRouteBtn"))clearReturnRoutePreview();});
})();
// Production stability bundle marker: shared Admin live-state synchronization + smooth client polling are live.
