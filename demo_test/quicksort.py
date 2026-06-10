test context
def quicksort(arr):
    """快速排序（经典 Lomuto 分区方案，原地排序）"""
    def _partition(low, high):
        pivot = arr[high]          # 选最后一个元素为基准
        i = low - 1                # i 指向小于 pivot 的区域的右边界
        for j in range(low, high):
            if arr[j] <= pivot:
                i += 1
                arr[i], arr[j] = arr[j], arr[i]
        arr[i + 1], arr[high] = arr[high], arr[i + 1]
        return i + 1

    def _sort(low, high):
        if low < high:
            pi = _partition(low, high)
            _sort(low, pi - 1)
            _sort(pi + 1, high)

    _sort(0, len(arr) - 1)
    return arr


def quicksort_hoare(arr):
    """快速排序（Hoare 分区方案，通常更快）"""
    def _partition(low, high):
        pivot = arr[(low + high) // 2]  # 选中间元素为基准
        i, j = low - 1, high + 1
        while True:
            i += 1
            while arr[i] < pivot:
                i += 1
            j -= 1
            while arr[j] > pivot:
                j -= 1
            if i >= j:
                return j
            arr[i], arr[j] = arr[j], arr[i]

    def _sort(low, high):
        if low < high:
            pi = _partition(low, high)
            _sort(low, pi)
            _sort(pi + 1, high)

    _sort(0, len(arr) - 1)
    return arr


# ---------- 辅助 ----------

def is_sorted(arr):
    """检查数组是否升序排列"""
    return all(arr[i] <= arr[i + 1] for i in range(len(arr) - 1))


# ---------- 测试 ----------

if __name__ == "__main__":
    import random

    #  Lomuto 版测试
    test1 = [3, 6, 8, 10, 1, 2, 1]
    print("原始:", test1)
    print("Lomuto 排序后:", quicksort(test1[:]))
    print("有序?", is_sorted(quicksort(test1[:])))

    # Hoare 版测试
    test2 = [3, 6, 8, 10, 1, 2, 1]
    print("\nHoare 排序后:", quicksort_hoare(test2[:]))
    print("有序?", is_sorted(quicksort_hoare(test2[:])))

    # 随机大数组性能测试
    large = [random.randint(0, 10_000) for _ in range(1000)]
    import time
    start = time.perf_counter()
    quicksort(large[:])
    print(f"\nLomuto 1000 元素耗时: {time.perf_counter() - start:.4f}s")

    start = time.perf_counter()
    quicksort_hoare(large[:])
    print(f"Hoare  1000 元素耗时: {time.perf_counter() - start:.4f}s")

    # 边界情况
    print("\n空数组:", quicksort([]))
    print("单元素:", quicksort([42]))
    print("已有序:", quicksort([1, 2, 3, 4, 5]))
    print("全相同:", quicksort([7, 7, 7, 7]))
